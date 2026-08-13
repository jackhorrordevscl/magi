# MAGI — Manual de uso

Este es el manual práctico de MAGI, pensado para alguien que ya labura con Claude Code y quiere entender qué hace esta herramienta, cómo instalarla, y cómo operarla en el día a día. No es una intro a "qué es un hook" — asumimos que ya tenés ese contexto. Lo que sí explicamos con lujo de detalle es todo lo específico de MAGI: sus modos, su clasificador de severidad, su CLI y sus archivos de configuración reales.

Todo lo que dice este manual está sacado del código tal cual está hoy en el repo (`README.md`, `src/`, `claude-code-hook/`, `magi.config.json`). Si en algún punto no pude confirmar algo con certeza, te lo digo explícitamente en vez de inventarlo.

---

## 1. Qué es MAGI

MAGI es un gate independiente que se engancha al hook `PreToolUse` de Claude Code. Cada vez que un agente de código propone ejecutar una acción (un comando de shell, un `Read`, un `Grep`, etc.), MAGI intercepta esa propuesta y decide `allow`/`deny` en base a dos mecanismos combinados:

1. Un **clasificador de severidad determinístico** (`src/gating/severity.ts`) — tablas de reglas, sin modelo de por medio — que le asigna a la acción un tier: `low`, `medium`, `high` o `critical`.
2. Un **consenso de tres evaluadores independientes** (Melchior, Balthasar, Casper), cada uno votando `allow`/`deny`/`abstain` con su propia rationale, sobre acciones que no son triviales.

Todo lo que pasa por el gate (menos lo que cae en la allowlist trivial) queda asentado en un **audit log con hash chain** — tamper-evident, no tamper-proof — antes de que el hook devuelva su decisión. Eso es lo que te permite después auditar, medir tasa de deny, y construir un corpus de calibración real.

MAGI hoy es **local-only, opt-in**. No hay despliegue productivo todavía, y el modo de operación se resuelve únicamente por la variable de entorno `MAGI_MODE` — nunca por un config file.

---

## 2. Instalación y wiring con Claude Code

Pasos exactos, tal cual figuran en el `README.md`:

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test "tests/**/*.test.ts"
npm run build       # bundles src/cli/main.ts -> dist/magi.mjs
```

Requiere Node.js >= 22 (está desarrollado y verificado contra Node v26, usando el modo nativo de TypeScript strip-only de Node — por eso vas a ver que cada clase del codebase asigna los campos del constructor explícitamente en el body, en vez de usar el shorthand de parameter properties, que ese modo de ejecución no soporta).

### Wiring del hook `PreToolUse`

Apuntá la configuración del hook `PreToolUse` de Claude Code directamente a `claude-code-hook/index.ts`. Se ejecuta con `node claude-code-hook/index.ts` — como Node soporta TypeScript nativo, no hace falta build previo para el hook (a diferencia del CLI `magi`, que sí se bundlea a `dist/magi.mjs`).

El hook:

- Lee el payload del tool call por **stdin** (JSON).
- Siempre sale con exit code `0` — la decisión real va en el JSON de stdout, nunca en el exit code.
- Imprime por **stdout** el contrato documentado de Claude Code para `PreToolUse`:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"|"deny","permissionDecisionReason":"..."}}
```

Seteá `MAGI_MODE=shadow` o `MAGI_MODE=enforced` en el entorno del hook (o dejalo sin setear — `shadow` es el default para cualquier valor ausente o inválido).

---

## 3. Modos: shadow vs enforced

### Shadow (`MAGI_MODE=shadow`, default)

**Nunca bloquea nada, pase lo que pase.** Aunque la severidad, los tres evaluadores y el consenso terminen dando `deny` en una acción crítica, el hook igual deja pasar el tool call de Claude Code.

Lo que sí hace, siempre, para toda acción no trivial: escribe el veredicto completo (decisión, severidad, los tres votos con sus rationales, actor, modo, timestamp) en el audit log hash-chained (`.magi/audit/`) **antes** de devolver `allow`. Esto es lo que hace útil al modo shadow aunque no bloquee nada: te deja medir qué hubiera decidido un gate enforcing contra actividad real, sin riesgo de trabar un workflow por un falso positivo.

Es un rollout deliberado en dos pasos: primero medís la tasa de falsos positivos en shadow, construís confianza en el juicio de los evaluadores (respaldado por un corpus de calibración real), y recién ahí pasás a enforcing por sesión.

Usá `magi audit stats` para ver la distribución de veredictos y el proxy de tasa de deny del período (ver sección 7).

### Enforced (`MAGI_MODE=enforced`)

**Bloquea el tool call cuando el veredicto calculado da `deny`.** El modo se resuelve exclusivamente por `MAGI_MODE` — `magi.config.json` no tiene ni va a tener una clave `mode` (esto es una regla explícita del diseño: "Single Mode Source"). Un veredicto `allow`, o el short-circuit de la allowlist trivial, se comportan igual en ambos modos. Toda acción se sigue auditando siempre, en cualquier modo, antes de que corra el gate de modo.

Cómo activarlo:

```bash
# Apuntá el hook PreToolUse de Claude Code a claude-code-hook/index.ts y seteá:
MAGI_MODE=enforced
```

Cuando bloquea, el `permissionDecisionReason` que le llega a Claude Code incluye **los tres votos individuales con sus rationales** (no solo la decisión agregada), más el hash del registro de auditoría y un hint listo para copiar con el comando de override. El proceso del hook siempre sale con exit `0` — la única autoridad es el `permissionDecision` del JSON.

**Orden de rollout recomendado:** arrancá en `shadow`, revisá `magi audit stats` un tiempo, y recién cuando confíes en la tasa de deny/false-positive, pasás a `enforced`.

---

## 4. Configurar los evaluadores

Los tres evaluadores — Melchior, Balthasar y Casper — están implementados sobre `GroqEvaluator` (`src/gating/groq-evaluator.ts`), que pega contra la API de chat completions compatible con OpenAI de Groq, usando `fetch` nativo (sin dependencia nueva de `groq-sdk`/`openai`).

### Modelo por defecto de cada uno

| Evaluador | Facet | Modelo Groq |
|---|---|---|
| **Melchior** (`src/gating/melchior.ts`) | fact/consistency | `openai/gpt-oss-120b` |
| **Balthasar** (`src/gating/balthasar.ts`) | blast radius a terceros + policy | `llama-3.3-70b-versatile` |
| **Casper** (`src/gating/casper.ts`) | actor risk/anomaly | `llama-3.1-8b-instant` |

### API key

Seteá `GROQ_API_KEY` en el entorno donde corre el hook (o el CLI, para `magi calibrate verify`). Es free tier — no pide tarjeta.

Cada `create*` (`createMelchior`, `createBalthasar`, `createCasper`) acepta `GroqEvaluatorOptions`:

```ts
interface GroqEvaluatorOptions {
  client?: GroqChatClient;   // fake inyectable para tests
  apiKey?: string;           // default: process.env.GROQ_API_KEY
  model?: string;
  timeoutMs?: number;        // default: 2500
  maxTokens?: number;        // default: 512
  baseUrl?: string;          // default: endpoint de Groq
}
```

Con eso podés, a nivel código, pisar el modelo/timeout/apiKey de un evaluador puntual, o inyectar un client fake para testear.

### Volver a Anthropic

`AnthropicEvaluator` (`src/gating/anthropic-evaluator.ts`) sigue existiendo y cumple el mismo contrato `EvaluatorPort` — por defecto usa `claude-3-5-haiku-latest`, timeout de 2500ms, y lee `ANTHROPIC_API_KEY`. Si querés que, por ejemplo, Melchior vuelva a estar backed por Anthropic en vez de Groq, lo construís directamente a nivel código:

```ts
import { AnthropicEvaluator } from './src/gating/anthropic-evaluator.ts';
import { MELCHIOR_FACET } from './src/gating/melchior.ts';

const melchiorAnthropic = new AnthropicEvaluator('melchior', MELCHIOR_FACET, {
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-3-5-haiku-latest',
});
```

Y después lo pasás en el array `evaluators` que espera `runHook`/`RunHookOptions` o `MainDeps.evaluators` (ver `src/cli/main.ts` y `claude-code-hook/index.ts`).

### Lo que NO existe todavía

**No hay ninguna forma de cambiar de evaluador vía archivo de configuración.** `magi.config.json` no tiene ni una clave para esto — el único mecanismo hoy es construir el evaluador a mano en código, como en el ejemplo de arriba. Un layer de config-file para elegir modelo/backend/timeout por evaluador está en fase de **exploración**, no aprobado ni planificado — ver sección 11.

---

## 5. La matriz de severidad

`src/gating/severity.ts` es 100% determinístico: mismo `ProposedAction` → mismo tier, siempre. La fórmula final es `max(tierPorReglas, adapterSeverityHint)` — un hint del adapter solo puede subir el tier, nunca bajarlo.

Un comando compuesto se descompone en sub-comandos (parser de shell propio) y se toma el tier más alto entre todos. Un comando que el parser no puede decomponer fuerza `high` — la ambigüedad nunca se trata como segura.

### Reglas de git (`GIT_RULES`)

| Regla (id) | Ejemplo | Tier |
|---|---|---|
| `git-reset-hard` | `git reset --hard` | high |
| `git-clean-fdx` | `git clean -fdx` | high |
| `git-push-force` | `git push --force origin feature-branch` | high |
| `git-push-force-protected-branch` | `git push --force origin main` | **critical** — el ejemplar del spec |
| `git-push-protected-branch-refspec` | `git push origin main` (sin `--force`, pero apunta a rama protegida) | high |
| `git-push-ambiguous-target` | `git push --force` (sin refspec explícito) | high |

Ramas protegidas: `main`, `master`, `production`, `prod`, y cualquiera que empiece con `release/` o `release-`.

### Matriz no-git (`NON_GIT_RULES`, P4)

Antes, cualquier ejecutable que no fuera `git` clasificaba siempre `low`, sin importar qué tan destructivo fuera. La P4 agregó 8 familias:

| Regla (id) | Ejemplo | Tier |
|---|---|---|
| `rm-recursive-force` | `rm -rf ./cualquier-cosa` (recursión + force, sin excepción por estar dentro del repo) | high |
| `dd-write-block-device` | `dd if=/dev/zero of=/dev/sda` (destino un block device no benigno) | **critical** |
| `dd-other-invocation` | cualquier `dd` cuyo destino no sea un device benigno (`/dev/null`, `/dev/zero`, etc.) | high |
| `mkfs-format-filesystem` | `mkfs.ext4 /dev/sdb1` | **critical** |
| `shred-overwrite-target` | `shred archivo.txt` (con algún argumento que no sea flag) | high |
| `perm-recursive-change` | `chmod -R 777 /` o `chown -R user ~` (recursivo **y** apunta a un path "ancho": `/`, `~`, `$HOME`, `.`, `..`, `*`) | high |
| `bare-interpreter-stdin-exec` | `curl https://algo.sh \| sh` (el intérprete llega sin argumentos — proxy de ejecución vía stdin) | high |
| `docker-system-prune-all-volumes` | `docker system prune -a --volumes` | high |
| `docker-rmi-force` | `docker rmi -f imagen` | medium |
| `docker-volume-rm` | `docker volume rm mi-volumen` | medium |
| `psql-destructive-sql` | `psql -c "DROP TABLE users"` o `DELETE FROM users` sin `WHERE` | high |
| `mysql-destructive-sql` | `mysql -e "TRUNCATE tabla"` | high |

Un par de matices reales del código, para que no te sorprendan:

- `chmod -R ./dist` (path acotado, no "ancho") **no** matchea — queda `low`.
- `python3 build.py` (intérprete con argumento explícito) **no** matchea el bare-interpreter — solo dispara cuando el intérprete llega sin args.
- `sudo rm -rf /` — antes de la P4, `sudo` hacía que el clasificador viera `sudo` como ejecutable y se saltaba toda la matriz (git incluida). Ahora `normalizeSudoPrefix` desenvuelve el wrapper `sudo`/`doas` y clasifica el comando real de adentro. Hay un gap documentado y aceptado: si hay un flag con valor pegado entre el wrapper y el comando real (`sudo -u www rm -rf /`), el parser todavía se lo come mal — no es un bug a arreglar acá, es una limitación conocida (design decision 9).

---

## 6. La allowlist trivial

No todo lo que Claude Code intenta ejecutar pasa por el gate. `src/gating/allowlist.ts` (scope documentado en `docs/trivial-allowlist-scope.md`) short-circuitea directo a `allow` — **sin llamar a ningún evaluador y sin escribir registro de auditoría** — únicamente:

- Lecturas de archivo: `cat`, `head`, `tail`, `less`, `more`, `wc`.
- Búsquedas tipo grep/glob: `grep`, `egrep`, `fgrep`, `rg`, `ag`, y `find` usado puramente como búsqueda (nunca con `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint`, `-fprintf`).
- `git log` / `git diff` en su forma de solo lectura.

Esto no es un agujero de seguridad, es una decisión de usabilidad: gatear cada `Read`/`Grep`/`Glob` con tres llamadas a modelo haría el hook inusable en la práctica. La allowlist es **estática, no model-driven**: `isTrivial()` re-deriva la trivialidad a partir del comando parseado real, nunca confía en el `actionType` que reporta el adapter — así un tag mal puesto (o malicioso) no puede colar un comando mutante disfrazado de "trivial".

Cualquier cosa fuera de ese set exacto — cualquier write, delete, red, instalación, ejecución de código arbitrario, cualquier comando que el parser no pueda decomponer, o cualquier chain compuesto donde un solo sub-comando caiga fuera del set — va sin excepción por el pipeline completo de severidad + quorum.

---

## 7. Comandos del CLI `magi`

El binario `magi` (`src/cli/main.ts`, se bundlea a `dist/magi.mjs` con `npm run build`, o corré directo con `node src/cli/main.ts <comando>`):

### `magi calibrate`

Te entrevista para agregar un ejemplar de calibración: tag, severidad, y una narrativa del juicio que hiciste. Nunca escribe sin confirmación explícita.

```
$ magi calibrate
Tag for this exemplar (e.g. "force-push-protected-branch"): force-push-main-desde-hotfix
Severity (low/medium/high/critical): critical
Describe the judgment call, in your own words: era un force-push a main después de un revert mal hecho, lo bloqueé
---
Tag: force-push-main-desde-hotfix
Severity: critical
Exemplar: era un force-push a main después de un revert mal hecho, lo bloqueé
---
Add this entry to the calibration corpus? (y/n) y
Added (contentHash a1b2c3...).
```

### `magi calibrate import <candidates.json>`

Revisa un array JSON de ejemplares candidatos, uno por uno, pidiendo confirmación por cada uno. Los que ya están en el corpus (contenido idéntico) se saltean sin preguntar.

```
$ magi calibrate import candidatos.json
---
Tag: chmod-recursivo-home
Severity: high
Exemplar: ...
---
Import this entry into the calibration corpus? (y/n) y
Imported 3 of 5 candidate(s).
```

### `magi calibrate verify --fixtures <fixtures.json>`

Corre el divergence harness contra los evaluadores reales (melchior/balthasar/casper) y un array JSON de fixtures diseñados. **No viene ningún set de fixtures pre-armado** — tenés que escribir el tuyo a partir de casos de juicio reales.

Forma esperada de cada fixture (`DivergenceFixture`, `src/calibration/divergence-harness.ts`):

```json
{
  "id": "fixture-01",
  "label": "force-push claramente ambiguo",
  "kind": "divergent",
  "severity": "high",
  "action": {
    "source": "coding_agent",
    "actor": "test-agent",
    "actionType": "shell_exec",
    "target": "origin/feature-x",
    "environment": "local",
    "mode": "shadow",
    "command": "git push --force origin feature-x"
  }
}
```

`kind: "divergent"` = fixtures donde los tres evaluadores DEBERÍAN discrepar; `kind: "control"` = donde DEBERÍAN coincidir unánimemente.

Output real (`formatAuditStats`-style, generado por `runCalibrateVerify`):

```
Divergent fixtures: 60.0% diverged (floor 40) — MET
Control fixtures: 100.0% unanimous — ALL UNANIMOUS
PASS
```

Exit code `0` si `report.pass`, `1` si no.

### `magi audit verify`

Reproduce el hash chain bajo `.magi/audit/` y te dice si está íntegro (tamper-evident, no tamper-proof — ver `src/audit/verify.ts`). Verifica igual de bien una cadena mezclando registros de veredicto y de override que una cadena solo-veredictos.

```
$ magi audit verify
Audit chain valid.
```

O, si está rota:

```
$ magi audit verify
Audit chain broken at seq 42: hash mismatch
```

### `magi audit stats`

Reporta distribución de veredictos (por decisión, por tier de severidad), un proxy crudo de tasa de deny del período, y el conteo/tasa de overrides como métrica separada. Salida real, línea por línea (`formatAuditStats`):

```
$ magi audit stats
Total gated records: 87
Decisions — allow: 71, deny: 16
Severity — low: 40, medium: 22, high: 20, critical: 5
Deny-rate proxy: 18.4% (raw proxy only — confirm each denial with a human before treating it as a real false positive)
Overrides: 3 (18.8% of denies overridden — documentary only, does not reclassify the original deny)
```

Importante: el "deny-rate proxy" NO es una tasa de falsos positivos real — MAGI no tiene ground truth sobre la intención real del operador. Solo te dice qué tan seguido *habría* bloqueado shadow mode. Confirmar cuáles de esos denies son falsos positivos genuinos requiere que un humano revise los registros denegados uno por uno.

### `magi audit override <hash> --reason "<why>"`

Ver sección 8.

---

## 8. El override humano auditado

`magi audit override <hash> --reason "<por qué>"` te deja documentar que un `deny` específico ya registrado debería ser ignorado — **sin mutar la cadena hash-chained** y **sin habilitar retry automático ni crear una entrada en la allowlist**.

```bash
magi audit override a1b2c3d4... --reason "operator verified this force-push manually"
```

Qué hace exactamente:

- Resuelve el registro objetivo **por hash de contenido, nunca por `seq`**.
- Exige un `--reason` no vacío.
- Solo acepta un objetivo cuya `decision` sea `deny` — cualquier rechazo (hash desconocido, reason faltante/vacío, o target que no sea `deny`) no escribe absolutamente nada.
- Agrega un **segundo tipo de registro**, distinto del veredicto (`OverrideRecordSchema`), al mismo hash chain, referenciando el registro original por hash.

Qué **NO** hace:

- No reintenta ni vuelve a ejecutar la acción original — si querés proceder, eso es un intento deliberado y separado del operador.
- No desbloquea nada automáticamente ni crea una excepción para próximas veces.
- No muta ni reescribe el registro original — el `deny` sigue estando ahí, contado como `deny` en `magi audit stats`.

`magi audit stats` reporta el override como métrica propia (`overrideCount`/`overrideRate`), nunca reclasifica el `deny` original fuera del conteo de denies.

Salida real:

```
$ magi audit override a1b2c3d4... --reason "operator verified this force-push manually"
Override recorded: e5f6a7b8... (targets a1b2c3d4...)
```

---

## 9. Calibración

El corpus de calibración (`.magi/calibration/`) es local-only, ya está en `.gitignore` — nunca se commitea, porque contiene el historial real de juicio del operador.

- **`magi calibrate`**: sirve para ir construyendo ese corpus de a un ejemplar, entrevistándote cada vez que tenés un caso de juicio interesante (típicamente después de revisar un deny real).
- **`magi calibrate import <file>`**: para volcar de una varios candidatos ya preparados (por ejemplo, extraídos de comentarios de review previos).
- **`magi calibrate verify --fixtures <file>`**: corre el divergence harness — prueba que las tres facetas de los evaluadores genuinamente discrepan en fixtures diseñados para divergir, y coinciden unánimemente en los de control. Esto es lo que detecta si los tres evaluadores colapsaron en tres copias cosméticas de un mismo juez genérico.

### Por qué los thresholds actuales son placeholders

Dos valores numéricos en `magi.config.json` están marcados explícitamente como placeholders, confirmados como aceptables para arrancar pero sin validación real todavía:

- `tiers.sync.k = 5` — top-K de ejemplares que trae el selector (se usa una vez que la inyección de calibración esté cableada).
- `tiers.async.k = 12` — actualmente sin uso, porque el modo async está fuera de scope.
- `tiers.divergenceFloorPercent = 40` — el piso mínimo de fracción de fixtures divergentes en los que las tres facetas deben genuinamente discrepar para que `magi calibrate verify` pase.

Ninguno de los dos fue derivado de datos reales de juicio de un operador — son valores de arranque. La recomendación explícita del proyecto es revisitarlos una vez que exista el primer corpus de calibración real, construido vía `magi calibrate`/`magi calibrate import`.

---

## 10. Casos de uso de ejemplo

### (a) Un agente intenta `cat README.md` en modo enforced

Cae directo en la allowlist trivial (`cat` está en `SAFE_READ_EXECUTABLES`). Ni un evaluador se llama, ni se escribe registro de auditoría. El hook responde:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"magi: trivial-scope allowlisted, not gated"}}
```

### (b) Un agente intenta `git push --force origin main` en modo enforced

`git-push-force-protected-branch` clasifica esto como **critical** — irreversible sobre estado compartido. Como es `critical`, hace falta consenso unánime 3-de-3 `allow` (a diferencia de low/medium, que solo piden 2-de-3). Es muy probable que alguno de los tres vote `deny` en un caso así.

El operador ve algo como:

```
magi: BLOCKED — consensus deny (severity: critical)
Action: git push --force origin main   Audit: a1b2c3d4...
Override: magi audit override a1b2c3d4... --reason "<why>"

MELCHIOR — deny: el comando es consistente pero fuerza sobreescritura de historia en rama protegida
BALTHASAR — deny: force-push a main excede el radio de impacto esperado para severidad critical, viola política de no force-push a ramas protegidas
CASPER — allow: el actor viene de un flujo de trabajo normal, sin señales de comportamiento anómalo
```

Si el operador revisa y concluye que fue un falso positivo (por ejemplo, era un force-push legítimo post-revert, coordinado con el equipo):

```bash
magi audit override a1b2c3d4... --reason "coordinado con el equipo, revert de un commit roto en main"
```

Esto documenta la disconformidad, pero **no vuelve a ejecutar el push** — eso lo tiene que hacer el operador aparte, deliberadamente.

### (c) Un operador revisa `.magi/audit/` periódicamente

```bash
magi audit verify   # confirma que la cadena no fue alterada
magi audit stats    # ve la distribución y el proxy de deny-rate
```

Si el deny-rate proxy viene alto y sospecha de falsos positivos, revisa los registros denegados a mano (leyendo el chain, o cruzando el hash con lo que reportó el hook) y decide caso por caso si amerita un `magi audit override` o si confirma que el gate estuvo bien.

### (d) Un operador construye el corpus de calibración después de revisar un deny real

Después de confirmar (o descartar) un deny como falso positivo real, lo convierte en un ejemplar de calibración:

```bash
magi calibrate
```

Y responde la entrevista con el tag, severidad, y la narrativa de por qué ese caso importa — para que, más adelante, cuando la inyección de exemplares esté cableada al pipeline de evaluadores, ese juicio humano quede disponible como contexto real.

---

## 11. Qué NO hace MAGI todavía

Directo del `README.md`, sección "Out of scope" y "What's next":

- **Adapter de pipeline CI/CD**: no hay pipeline de producción todavía para gatear. El shape `InfraPipelineActionSchema` existe en el código como stub tipado, pero la clasificación de severidad para ese source siempre da `high` fijo (fail-closed) — no hay tabla de reglas real todavía.
- **Modo async con bounded tool loop + escalación humana**: un modelo más fuerte con acceso a herramientas real y acotado, que escale veredictos ambiguos/alta-severidad a un humano con timeout de fallo visible. No está construido.
- **Layer de config-file para elegir modelo/backend/timeout por evaluador**: hay una exploración (no propuesta, no spec, no diseño, cero código) sobre esto. Hoy la única forma de cambiar el backend de un evaluador es a nivel código (sección 4).
- **TUI (interfaz de terminal)**: también en fase de exploración — pensada sobre readline/ANSI plano (no un framework como `ink`/`blessed`, por la convención de mínimas dependencias del proyecto), para leer/escribir esa futura config y renderizar `magi audit stats` de forma interactiva. Ninguna de las dos partes está aprobada ni planificada — es exploración, no un compromiso.

---

## 12. Dónde mirar si algo falla

- **¿El audit log existe y es coherente?** Corré `magi audit verify`. Si dice `Audit chain broken at seq <n>: <reason>`, algo alteró `.magi/audit/` — no es un caso de "está vacío", es corrupción real.
- **¿El hook está en el modo que pensás que está?** Confirmá que `MAGI_MODE` esté seteado (y en el entorno correcto — el que ve el proceso del hook, no solo tu shell interactiva) tal cual vos lo configuraste. Recordá: cualquier valor no reconocido cae en `shadow` por default — si esperabas `enforced` y nada bloquea, es lo primero a chequear.
- **¿Los evaluadores están tirando `deny` en todo, o tardando mucho?** Fijate si `GROQ_API_KEY` está seteada en el entorno del hook — sin ella, `GroqEvaluator` manda `Authorization: Bearer` vacío y la API va a rechazar todo, lo cual el evaluador fail-closea a `deny` (nunca lo reintenta ni lo repara). Si estás usando `AnthropicEvaluator` en su lugar, es `ANTHROPIC_API_KEY` la que tenés que revisar. También podés estar pegando contra el timeout de 2500ms por defecto (`timeoutMs`) — un `deny` con rationale `"evaluator error/timeout, fail-closed to deny: ..."` es la pista.
- **¿Un veredicto que esperabas denegado terminó permitido, o viceversa?** Revisá primero qué tier calculó `classify()` — capaz el comando no matchea ninguna regla de `GIT_RULES`/`NON_GIT_RULES` (sección 5) y por eso quedó en `low`, o cayó directo en la allowlist trivial (sección 6) y ni pasó por los evaluadores.

---

**Nota sobre cosas que no pude confirmar 100% desde el código**: no encontré ningún fixture de ejemplo pre-armado para `magi calibrate verify` dentro del repo — el README y el propio mensaje de error del CLI confirman que no viene ninguno, así que el ejemplo de fixture de la sección 7 es una construcción propia siguiendo exactamente el schema real (`DivergenceFixture`), no un archivo real leído del repo.

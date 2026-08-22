<p align="center">
  <img src="Nerv-logo.webp" alt="Logo de NERV" width="180">
</p>

# MAGI — Multi-Agent Action Gating

<p align="center">
  <img src="magi01.jpg" alt="Banner de MAGI" width="100%">
</p>

MAGI es una puerta de control independiente y multi-perspectiva que decide
allow/deny sobre acciones de alto impacto propuestas por agentes de código
(y, en una fase futura, por pipelines de CI/CD) antes de que se ejecuten.
Tres evaluadores independientes — **Melchior** (hechos/consistencia),
**Balthasar** (radio de impacto sobre terceros + política) y **Casper**
(riesgo/anomalía del actor) — emiten un voto cada uno por acción propuesta;
un clasificador de severidad determinístico y basado en tablas decide
cuánto consenso se requiere antes de permitir una acción.

Este repositorio actualmente entrega **v1, alcance P0–P3**: núcleo de
gating determinístico, log de auditoría encadenado por hash con un tipo de
registro de anulación humana auditada, un adaptador de hook `PreToolUse`
de Claude Code que soporta tanto el modo **shadow** como el **enforcing**,
y un corpus de calibración basado en juicio humano + un harness de
divergencia. Sobre esa base, P4 extiende el clasificador de severidad
determinístico con una matriz de amenazas no-git (implementado, verificado
y archivado — ver
[Matriz de amenazas no-git](#matriz-de-amenazas-no-git-p4) más abajo). Ver
[Alcance](#alcance-p0p4-este-repositorio) y
[Fuera de alcance](#fuera-de-alcance--no-implementado-aquí) más abajo para
el límite preciso. Para una guía práctica de uso día a día (modos, la
matriz de severidad, todos los comandos de la CLI, cambio de backend de
evaluador, resolución de problemas), ver [MANUAL.md](MANUAL.md).

## Estado: solo local, modo enforcing opt-in

Este proyecto **aún no tiene un objetivo de despliegue en producción**. El
modo se resuelve exclusivamente a partir de la variable de entorno
`MAGI_MODE`, con `shadow` como valor por defecto ante cualquier valor
ausente o inválido — el comportamiento enforcing es opt-in por sesión,
nunca un valor por defecto en un archivo de configuración. Ver
[Modo shadow](#modo-shadow-siempre-permite-siempre-registra) y
[Modo enforcing](#modo-enforcing-bloquea-veredictos-deny--anulación-humana-auditada)
más abajo para el detalle exacto de cada modo.

## Alcance (P0–P4, este repositorio)

| Fase | Qué entrega |
|---|---|
| P0 — núcleo de dominio + auditoría | Normalización de `ProposedAction`, clasificación de severidad basada en tablas (`src/gating/severity.ts`), la allowlist estática de solo lectura de alcance trivial (`src/gating/allowlist.ts`), consenso por quorum + ensamblado de veredicto (`src/gating/consensus.ts`, `src/gating/verdict.ts`), y el sink de auditoría encadenado por hash a prueba de manipulación (`src/audit/`). |
| P1 — hook en modo shadow | El adaptador de hook `PreToolUse` de Claude Code (`claude-code-hook/index.ts`), que conecta allowlist → severidad → evaluadores → consenso → veredicto → auditoría en un solo pipeline, corriendo en `MAGI_MODE=shadow`. |
| P2 — calibración + harness de divergencia | Un corpus de calibración local basado en juicio humano (`src/calibration/corpus.ts`), recuperación léxica determinística de ejemplares (`src/calibration/selector.ts`), y un harness de divergencia (`src/calibration/divergence-harness.ts`) que demuestra que las tres facetas evaluadoras realmente discrepan en fixtures diseñados para divergir y coinciden en los controles — detectando colapso cosmético de persona. |
| P3 — modo enforcing + anulación humana auditada | `MAGI_MODE=enforced` efectivamente bloquea un veredicto `deny` a través del contrato documentado `hookSpecificOutput` de Claude Code, y `magi audit override <hash> --reason "<why>"` permite que un operador documente que un `deny` registrado debe ser descartado, sin mutar la cadena de auditoría. |
| P4 — extensión de la matriz de amenazas no-git | Una tabla `NON_GIT_RULES` en el clasificador de severidad (`src/gating/severity.ts`) que cubre 8 familias de comandos destructivos más allá de `git`, además de una corrección en el dispatch para que los comandos prefijados con `sudo`/`doas` ya no eludan la matriz de amenazas. Verificado (`sdd-verify`: PASS WITH WARNINGS, 0 críticos) y archivado — ver [Matriz de amenazas no-git](#matriz-de-amenazas-no-git-p4) más abajo. |

Tres evaluadores independientes respaldan cada acción gateada no trivial:

- **Melchior** — hechos/consistencia (`src/gating/melchior.ts`)
- **Balthasar** — radio de impacto sobre terceros + política (`src/gating/balthasar.ts`)
- **Casper** — riesgo/anomalía del actor (`src/gating/casper.ts`)

Regla de consenso/quorum (spec Requirement: Consensus and Quorum):
severidad baja/media requiere 2-de-3 `allow`; severidad alta/crítica
requiere unanimidad 3-de-3 `allow`. `abstain` nunca cuenta hacia `allow`,
en ningún nivel. Un timeout o error de transporte de un evaluador en el
tier síncrono se trata como `deny` (fail-closed), nunca como `allow`.

Por defecto, los tres evaluadores nombrados están respaldados por la API
gratuita de [Groq](https://groq.com) (`src/gating/groq-evaluator.ts`,
`GROQ_API_KEY` — gratis, sin tarjeta requerida), cada uno con su propio
modelo confirmado del tier gratuito: Melchior usa `openai/gpt-oss-120b`,
Balthasar usa `llama-3.3-70b-versatile`, y Casper usa
`llama-3.1-8b-instant`. Existen dos backends alternativos de
`EvaluatorPort` que satisfacen el mismo contrato pero **no** están
conectados a producción: `AnthropicEvaluator`
(`src/gating/anthropic-evaluator.ts`, `ANTHROPIC_API_KEY`) y
`GeminiEvaluator` (`src/gating/gemini-evaluator.ts`, `GEMINI_API_KEY`, con
`gemini-2.5-flash-lite` como modelo por defecto). Cada función `create*`
(`createMelchior`/`createBalthasar`/`createCasper`) acepta
`GroqEvaluatorOptions` (`client`, `apiKey`, `model`, `timeoutMs`,
`maxTokens`, `baseUrl`) para sobrescribir la configuración del backend
Groq por defecto o inyectar un doble de prueba; para cambiar el backend
por completo (por ejemplo, a Anthropic o a Gemini), construir
`new AnthropicEvaluator(name, facet, options)` o
`new GeminiEvaluator(name, facet, options)` directamente con la faceta
correspondiente de `melchior.ts`/`balthasar.ts`/`casper.ts` en lugar de
usar `create*`, y pasar el resultado vía `RunHookOptions.evaluators` /
`MainDeps.evaluators` — ver MANUAL.md, sección 4, para ejemplos concretos
de ambos cambios de backend.

Más allá de la inyección a nivel código, `magi.config.json` también
acepta una clave opcional de primer nivel `evaluators` — hermana de
`tiers`/`paths` — que le permite a un operador setear
`backend`/`model`/`timeoutMs`/`maxTokens` de cada evaluador nombrado sin
tocar código ni recompilar (`src/gating/evaluator-config.ts`, leído por
`melchior.ts`/`balthasar.ts`/`casper.ts`). `apiKey` deliberadamente nunca
es un campo de config — las API keys siguen siendo solo por variable de
entorno. Precedencia: la inyección a nivel código (arriba) siempre gana
sobre esta config; esta config siempre gana sobre los defaults
hardcodeados. `magi tui` (ver [Comandos de la CLI](#comandos-de-la-cli) más
abajo) edita esta sección de forma interactiva. Ver MANUAL.md, sección 4,
para la referencia completa de campos y reglas de validación.

## Modo shadow: siempre permite, siempre registra

**`MAGI_MODE=shadow` nunca bloquea una llamada a herramienta,
independientemente del veredicto calculado.** Si la clasificación de
severidad, los tres evaluadores y la resolución de consenso calculan en
conjunto `deny` para una acción crítica, el adaptador de hook igual
permite que la llamada subyacente a la herramienta de Claude Code
proceda.

Lo que el modo shadow *sí* hace, incondicionalmente, para cada acción
gateada no trivial: agrega de forma durable el veredicto completo —
decisión, severidad, los tres votos de los evaluadores + sus
justificaciones, actor, modo, timestamp — al log de auditoría encadenado
por hash (`.magi/audit/`) **antes** de que el hook devuelva su decisión
`allow`. Esto es lo que hace útil al modo shadow aunque nunca bloquee:
mide qué habría decidido una puerta enforcing, contra la actividad real
del agente día a día, sin ningún riesgo de que una puerta demasiado
agresiva trabe un flujo de trabajo real.

Cada registro de veredicto también carga `calibrationCorpusHash`/
`exemplarIds` (el snapshot del corpus de calibración y los hashes de los
ejemplares recuperados detrás de ese voto) y `corpusDegraded` (`true`
cuando esa lectura del corpus fue degradada — directorio ilegible o una
entrada corrupta salteada — `false` para un corpus genuinamente vacío o
sano). Los tres campos ya están en cada registro del hash chain y ya los
muestra tanto `magi audit stats` (conteo/tasa de corpus degradado,
hashes de corpus distintos, cobertura de exemplares) como la pantalla
Audit de `magi tui` (corpus hash/cantidad de exemplares por registro,
más una línea de alarma resaltada en rojo cuando `corpusDegraded` es
`true`) — el JSONL crudo bajo `.magi/audit/` sigue disponible para
cualquier cosa que las vistas resumidas no cubran.

Este es un rollout deliberado en dos pasos (ver el plan P1 → P4 de
`sdd/magi/design`): observar y medir la tasa de falsos positivos primero
en modo shadow, generar suficiente confianza en el juicio de los
evaluadores (respaldado por un corpus de calibración real), y solo
entonces pasar a enforcing por sesión vía `MAGI_MODE=enforced` — ver
[Modo enforcing](#modo-enforcing-bloquea-veredictos-deny--anulación-humana-auditada)
más abajo.

Usar `magi audit stats` para ver la distribución de veredictos registrada
y un proxy bruto de tasa de deny para el período de evaluación (ver
[Comandos de la CLI](#comandos-de-la-cli) más abajo).

## Modo enforcing: bloquea veredictos deny + anulación humana auditada

**`MAGI_MODE=enforced` bloquea una llamada a herramienta cuando la
`decision` del veredicto calculado es `deny`** (el modo se resuelve
exclusivamente a partir de la variable de entorno `MAGI_MODE` —
`magi.config.json` no lleva ninguna clave `mode` en absoluto, ver spec
Requirement: Single Mode Source). Cualquier veredicto `allow`, y el
cortocircuito de la allowlist de alcance trivial, se comportan idéntico
en ambos modos. Cada acción sigue siendo auditada de forma durable antes
de que corra la puerta de modo, en cualquiera de los dos modos.

Un bloqueo se comunica a Claude Code a través del contrato documentado
`hookSpecificOutput` de `PreToolUse` (`permissionDecision: "deny"`), con
una razón que incluye **los votos individuales y las justificaciones de
los tres evaluadores** (no solo la decisión agregada), más el hash del
registro de auditoría y una sugerencia de anulación lista para copiar. El
proceso del hook siempre termina con código de salida `0` — el
`permissionDecision` del JSON es la única autoridad, nunca el código de
salida.

```bash
# Apuntar el hook PreToolUse de Claude Code a claude-code-hook/index.ts y establecer:
MAGI_MODE=enforced
```

### Anulación humana auditada

El bloqueo no es el final de la historia: `magi audit override <hash>
--reason "<why>"` permite que un operador documente que un `deny`
registrado específico debe ser descartado — **sin mutar la cadena de
auditoría a prueba de manipulación** y **sin otorgar una entrada en la
allowlist ni disparar un reintento automático**. Agrega un segundo tipo de
registro distinto (`OverrideRecordSchema`) a la misma cadena de hash,
referenciando el registro original por su hash:

```bash
magi audit override <hash> --reason "operator verified this force-push manually"
```

La CLI resuelve el objetivo **por hash de contenido, no por `seq`**,
requiere un `--reason` no vacío, y solo acepta un objetivo cuya `decision`
sea `deny` — cualquier rechazo (hash desconocido, razón faltante/vacía, o
un objetivo que no sea `deny`) no escribe nada en absoluto. La acción en
sí nunca es re-ejecutada por el comando de anulación; proceder es un
reintento separado y deliberado del operador. `magi audit stats` reporta
el conteo/tasa de anulaciones como su propia métrica — una anulación
nunca reclasifica el registro original fuera del conteo de deny.

### Allowlist de alcance trivial

No todas las llamadas a herramientas interceptadas son gateadas. Una
allowlist estática, definida en código (`src/gating/allowlist.ts`, con el
alcance documentado en `docs/trivial-allowlist-scope.md`) cortocircuita
**únicamente** operaciones confirmadas de solo lectura y sin efectos
secundarios (lecturas de archivo, `git log`/`git diff`, búsquedas tipo
grep/glob) directo a allow — sin llamadas a evaluadores, sin registro de
auditoría. Esto es lo que mantiene el hook usable: gatear cada llamada a
`Read`, `Grep` y `Glob` a través de tres llamadas a modelo cada una
haría que el adaptador fuera inutilizable en la práctica. Todo lo demás —
cada mutación, cada ejecución, cada comando que la allowlist no puede
confirmar positivamente como trivial — pasa por el pipeline completo de
severidad/quorum sin excepción.

### Matriz de amenazas no-git (P4)

El clasificador de severidad determinístico (`src/gating/severity.ts`)
antes solo tenía reglas de matriz de amenazas para el ejecutable `git` —
cualquier otro ejecutable (`rm`, `dd`, `docker`, un CLI de SQL, etc.)
siempre se clasificaba como severidad `low`, sin importar cuán
destructivo fuera el comando real. Una nueva tabla `NON_GIT_RULES` ahora
cubre 8 familias de comandos destructivos: `rm -rf`, `dd` (escrituras a
dispositivo), `mkfs*`, `shred`, `chmod -R`/`chown -R` (cambios amplios de
permisos), detección de proxy bare-interpreter pipe-to-shell (por ejemplo
`curl ... | sh`), subcomandos destructivos de `docker` (`system prune -a
--volumes`, `rmi -f`, `volume rm`), y sentencias destructivas inline de
CLIs de bases de datos (`psql -c`/`mysql -e` que contengan
`DROP`/`TRUNCATE`/un `DELETE` sin calificar). Una corrección relacionada
en el mismo commit: los comandos prefijados con `sudo`/`doas` (por
ejemplo `sudo rm -rf /`) antes eludían *toda* la matriz de amenazas
(incluidas las reglas de git) porque el parser reportaba `sudo` como el
ejecutable — el dispatch ahora normaliza más allá del wrapper sudo/doas
antes de clasificar.

Este trabajo está implementado, verificado y archivado (`045ce2f` en
`master`, sobre la base P0–P3; `a874dd7` corrige un gap en el tier de
`dd` que `sdd-verify` detectó contra el spec aprobado — un `dd` que no
escribe a un dispositivo ahora escala correctamente a `high` en vez de
caer en `low`), con la suite de tests completa pasando (395/395). El
veredicto final de `sdd-verify` es PASS WITH WARNINGS: 0 hallazgos
críticos, 1 warning no bloqueante (falta un test negativo literal para
`python3 script.py` en la regla de intérprete sin argumentos), 1
sugerencia cosmética (un desajuste de conteo de escenarios en el spec)
— ninguno bloquea la corrección funcional.

## Fuera de alcance — NO implementado aquí

Lo siguiente está explícitamente diferido a un cambio futuro, según el
límite "fuera de alcance" propio de `sdd/magi/tasks` y la decisión de
rollout solo-local (`sdd/magi/design-decisions`):

- **Adaptador de pipeline CI/CD** (Requirement: CI/CD Pipeline Adapter del
  modo async). Todavía no hay un pipeline de producción que gatear.
- **Bucle de herramientas acotado + escalamiento humano del modo async**
  (un modelo más fuerte con acceso real y acotado a herramientas, que
  escala veredictos ambiguos/de alta severidad a un humano con un timeout
  de fallo visible).

Construir cualquiera de los dos puntos anteriores ahora, contra una
postura de pipeline y escalamiento que aún no existe, sería prematuro —
este es un límite de alcance deliberado, no un descuido. (El modo
enforcing y la CLI de anulación humana auditada, listados anteriormente
aquí, se entregaron en P3 — ver
[Modo enforcing](#modo-enforcing-bloquea-veredictos-deny--anulación-humana-auditada)
arriba.)

## Valores placeholder — revisar tras el primer corpus real

Dos umbrales numéricos en `magi.config.json` y el harness de calibración
son **placeholders** explícitos, confirmados como aceptables para
proceder antes de que exista un corpus de calibración real
(`sdd/magi/design-decisions`):

- **Top-K del selector**: `tiers.sync.k = 5` — ya conectado: `runHook`
  resuelve e inyecta exemplars reales del corpus en el prompt de cada
  evaluador (ver `sdd/magi-calibration-live-wiring`), así que este valor
  ya es determinante en cuanto `.magi/calibration/` tenga entradas.
  `tiers.async.k = 12` sigue sin uso — el modo async en sí está fuera de
  alcance, ver arriba.
- **Piso del harness de divergencia**: `tiers.divergenceFloorPercent = 40`
  — la fracción mínima de fixtures diseñados para divergir sobre la que
  las tres facetas evaluadoras deben realmente discrepar para que `magi
  calibrate verify` pase.

Ambos valores son placeholders precisamente porque todavía no existe un
corpus de calibración real contra el cual validarlos — nunca fueron
derivados de datos reales de juicio del operador. **Revisar ambos una vez
que exista el primer corpus de calibración real** (construido vía `magi
calibrate` / `magi calibrate import`, ver más abajo), en lugar de tratar
cualquiera de los dos números como definitivo hoy.

## Configuración

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test "tests/**/*.test.ts"
npm run build        # empaqueta src/cli/main.ts -> dist/magi.mjs
```

Requiere Node.js >= 22 (desarrollado y verificado contra la ejecución
nativa strip-only de TypeScript de Node v26 — cada clase en este código
asigna los campos del constructor explícitamente en el cuerpo, ya que ese
modo de ejecución no soporta el azúcar sintáctico de parameter-property).

## Comandos de la CLI

El binario `magi` (`src/cli/main.ts`, empaquetado a `dist/magi.mjs` por
`npm run build`, o ejecutado directamente vía `node src/cli/main.ts
<command>`):

| Comando | Qué hace |
|---|---|
| `magi calibrate` | Entrevista al operador para un ejemplar de calibración (tag, severidad, narrativa de juicio). Nunca escribe sin confirmación explícita. |
| `magi calibrate import <candidates.json>` | Revisa un array JSON de ejemplares candidatos uno a la vez, requiriendo confirmación por entrada antes de escribir. Los candidatos ya presentes (contenido idéntico) se omiten sin preguntar. |
| `magi calibrate verify --fixtures <fixtures.json>` | Corre el harness de divergencia contra los evaluadores reales melchior/balthasar/casper y un array JSON de fixtures diseñados (`{id, kind: "divergent"\|"control", action, severity}[]`). Todavía no se distribuye ningún conjunto de fixtures incorporado — crear el propio a partir de juicios reales una vez que se tengan algunos. |
| `magi audit verify` | Reproduce la cadena de hash bajo `.magi/audit/` y reporta si está intacta (a prueba de manipulación, no infalible ante manipulación — ver `src/audit/verify.ts`). Verifica una cadena que mezcla registros de veredicto y de anulación de forma idéntica a una cadena de solo veredictos. |
| `magi audit stats` | Reporta la distribución de veredictos (conteos por decisión, por nivel de severidad), un proxy bruto de tasa de deny para el período de evaluación, y el conteo/tasa de anulaciones como métrica separada. |
| `magi audit override <hash> --reason "<why>"` | Documenta que el registro de deny que coincide con `<hash>` debe ser descartado — append-only, no mutante, requiere un `--reason` no vacío, solo acepta un objetivo `deny`. No escribe nada en ningún camino de rechazo. |
| `magi tui` | Interfaz de terminal interactiva (`blessed`) para editar la sección `evaluators` de la config y navegar los denies del audit log sin salir de la terminal — ver [MANUAL.md](MANUAL.md) §7. |

El corpus de calibración (`.magi/calibration/`) y el log de auditoría
(`.magi/audit/`) son ambos solo-local y ya están excluidos vía
`.gitignore` — el corpus contiene el historial real de juicio de revisión
del operador y nunca se commitea a un repositorio compartido/remoto.

## Conexión del hook de Claude Code

Apuntar la configuración del hook `PreToolUse` de Claude Code a
`claude-code-hook/index.ts` (ejecutado directamente vía `node
claude-code-hook/index.ts` — el soporte nativo de TypeScript de Node
significa que no se requiere paso de build para el hook en sí). Establecer
`MAGI_MODE=shadow` o `MAGI_MODE=enforced` en el entorno del hook (u
omitirlo — `shadow` es el valor por defecto para cualquier valor ausente o
inválido). El hook lee el payload de la llamada a herramienta desde
stdin, siempre termina con código de salida `0`, e imprime a stdout el
contrato de salida documentado de `PreToolUse` de Claude Code:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"|"deny","permissionDecisionReason":"..."}}
```

`permissionDecision` es `"deny"` solo cuando `MAGI_MODE=enforced` y el
veredicto calculado es `deny`; cualquier otro caso (modo shadow, un
veredicto `allow`, el cortocircuito trivial, o un fallo del lado del
adaptador — que siempre falla abierto) reporta `"allow"`.

Este repositorio se gatea a sí mismo: `.claude/settings.json` conecta un
hook `PreToolUse` que corre `node claude-code-hook/index.ts` con
`MAGI_MODE=shadow` en cada llamada a herramientas dentro de una sesión de
Claude Code trabajando sobre este repo (commit `c0e9602`). Es dogfooding
real — las propias sesiones de desarrollo de MAGI son auditadas por MAGI,
sin bloquear nada.

## Referencias de arquitectura

- [MANUAL.md](MANUAL.md) — la guía práctica de uso día a día (modos,
  matriz de severidad, referencia completa de la CLI, cambio de backend de
  evaluador, resolución de problemas).
- `sdd/magi/spec` — los requisitos/escenarios formales contra los que está
  construida esta implementación.
- `sdd/magi/design` — el stack fijado y las decisiones de arquitectura.
- `sdd/magi/tasks` — el desglose completo de tareas fase por fase.
- `sdd/magi-p3-enforcing-override/spec` — requisitos/escenarios para el
  modo enforcing y la anulación humana auditada.
- `sdd/magi-p3-enforcing-override/design` — decisiones de arquitectura
  detrás de la puerta de modo enforcing y el tipo de registro de
  anulación.
- `openspec/specs/multi-provider-evaluators/spec.md` — los
  requisitos/escenarios formales contra los que está construido
  `GeminiEvaluator`.
- `docs/trivial-allowlist-scope.md` — el límite confirmado de la
  allowlist de alcance trivial.

## Qué sigue — exploración en curso, aún sin planificar

`codegraph-context-in-evaluators` solo fue mencionado de pasada, nunca
pasó por exploración formal. Un adaptador para OpenCode sí se exploró
(`sdd/explore/opencode-adapter`): es técnicamente viable reusar `runHook`
sin modificarlo, desde un módulo standalone nuevo (plugin in-process),
pero todavía no está aprobado para pasar a `sdd-propose` — faltan una
decisión del operador sobre el discriminated union de `ProposedAction` y
la confirmación del contrato oficial de plugins de OpenCode.

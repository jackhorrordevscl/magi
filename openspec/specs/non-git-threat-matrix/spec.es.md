> Traducción de `spec.md`. En caso de discrepancia, el archivo en inglés es la fuente de verdad.

# Especificación de la Matriz de Amenazas No-Git

## Propósito

Extiende la matriz de amenazas del clasificador de severidad de MAGI (spec base: `sdd/magi/spec` #1006, Requirement: Severity Tier Classification) más allá de `git` hacia los ejecutables destructivos no-git que un agente de codificación puede invocar. Hoy `classifySubCommand` (`src/gating/severity.ts`) devuelve `low` para todo ejecutable excepto `git`, de modo que `rm -rf /`, `mkfs.ext4 /dev/sda`, `curl … | sh`, y las invocaciones destructivas de `docker`/CLI de bases de datos puntúan todas igual que un comando de solo lectura. Esta capacidad agrega una segunda tabla de reglas indexada por ejecutable (`NON_GIT_RULES`, que refleja la forma de la `GIT_RULES` existente) despachada desde el mismo punto `classifySubCommand`, de modo que el tier — y por lo tanto el costo del quorum — refleje también el radio de impacto real de los comandos no-git.

## Requirements

### Requirement: Despacho de la Tabla de Reglas No-Git

`classifySubCommand` DEBE despachar a través de un mapa de reglas indexado por ejecutable (`NON_GIT_RULES`) para cualquier `sub.executable` distinto de `git`, replicando estructuralmente a `GIT_RULES` (un arreglo ordenado de predicados `{ id, matches, tier }` sobre el `SubCommand` ya descompuesto), antes de recurrir al valor por defecto `low`. Las reglas DEBEN permanecer como predicados puros sin ninguna llamada a modelo, reutilizando los helpers existentes `shortFlagChars` y `maxTier` cuando corresponda.

#### Scenario: Un ejecutable no-git se busca en la nueva tabla

- GIVEN un sub-comando con `executable: 'rm'` y `args: ['-rf', '/tmp/x']`
- WHEN `classifySubCommand` se ejecuta
- THEN evalúa el sub-comando contra `NON_GIT_RULES` (no `GIT_RULES`) y devuelve el tier de mayor coincidencia

### Requirement: rm -rf Escala Incondicionalmente

El sistema DEBE clasificar cualquier invocación de `rm` que combine las flags cortas `-r`/`-R` y `-f` (en cualquier combinación, por ejemplo `-rf`, `-fr`, `-r -f`) como `high`, sin importar la amplitud o especificidad de la ruta objetivo. No existe un tier inferior para un objetivo acotado a una ruta dentro del repositorio (por ejemplo, `./dist`, `./node_modules`).

#### Scenario: rm -rf sobre un objetivo amplio

- GIVEN el comando `rm -rf /`
- WHEN se clasifica
- THEN la severidad es `high`

#### Scenario: rm -rf sobre un objetivo acotado dentro del repositorio

- GIVEN el comando `rm -rf ./node_modules`
- WHEN se clasifica
- THEN la severidad es `high` (sin excepción para la ruta acotada)

### Requirement: dd Escala Según el Destino

El sistema DEBE clasificar una invocación de `dd` como `critical` cuando su argumento `of=` apunta a una ruta de dispositivo de bloque crudo (`/dev/*`), y como `high` para cualquier otra invocación de `dd`.

#### Scenario: dd apuntando a un dispositivo crudo

- GIVEN el comando `dd if=/dev/zero of=/dev/sda`
- WHEN se clasifica
- THEN la severidad es `critical`

#### Scenario: dd apuntando a un archivo regular

- GIVEN el comando `dd if=/dev/zero of=./image.bin`
- WHEN se clasifica
- THEN la severidad es `high`

### Requirement: mkfs* Escala a Critical

El sistema DEBE clasificar cualquier invocación de un ejecutable de creación de sistemas de archivos (`mkfs` o cualquier variante `mkfs.*`, por ejemplo `mkfs.ext4`, `mkfs.xfs`) como `critical`, ya que destruye todos los datos de su objetivo incondicionalmente.

#### Scenario: mkfs.ext4 sobre un dispositivo

- GIVEN el comando `mkfs.ext4 /dev/sda1`
- WHEN se clasifica
- THEN la severidad es `critical`

### Requirement: shred Escala a High

El sistema DEBE clasificar cualquier invocación de `shred` como `high`, ya que realiza un borrado seguro irreversible de su objetivo.

#### Scenario: shred sobre un archivo

- GIVEN el comando `shred -u secrets.txt`
- WHEN se clasifica
- THEN la severidad es `high`

### Requirement: chmod -R / chown -R Sobre una Ruta Amplia Escala a High

El sistema DEBE clasificar una invocación de `chmod -R`/`chown -R` (o `-r`, flags cortas combinadas) como `high` cuando su argumento objetivo sin flag es una ruta amplia o de tipo raíz (`/`, `~`, `$HOME`, `.`, `..`, `*`). Un `chmod -R`/`chown -R` acotado a una ruta específica dentro del repositorio no es capturado por esta regla y permanece en `low` (no dispara ninguna regla) — es un riesgo de regresión de permisos de seguridad, no de destrucción de datos, por lo que no aplica ningún tier superior a `high`.

#### Scenario: chmod -R sobre la raíz del sistema de archivos

- GIVEN el comando `chmod -R 777 /`
- WHEN se clasifica
- THEN la severidad es `high`

#### Scenario: chown -R sobre el directorio home

- GIVEN el comando `chown -R user:user ~`
- WHEN se clasifica
- THEN la severidad es `high`

#### Scenario: chmod -R acotado a una ruta dentro del repositorio no coincide

- GIVEN el comando `chmod -R 755 ./dist`
- WHEN se clasifica
- THEN esta regla no coincide; la severidad permanece en `low` a menos que otra regla coincida

### Requirement: El Proxy de Intérprete Desnudo con Pipe a Shell Escala a High

El sistema DEBE clasificar una invocación de intérprete desnudo (`sh`, `bash`, `zsh`, `dash`, `python`, `python3`, `perl`, `ruby`, o `node`) sin argumentos como `high`. Dado que el tokenizador divide `|` como separador de nivel superior, `curl … | sh` se descompone en dos sub-comandos independientes; el sub-comando de intérprete sin argumentos es la única señal disponible, y para un agente no interactivo se trata como un proxy para la ejecución de scripts vía pipe/stdin. Esta regla vive enteramente en `severity.ts` — no involucra ningún cambio en `command-parser.ts` ni en `tokenizer.ts`.

#### Scenario: Ejecución de script mediante pipe a través de sh desnudo

- GIVEN el comando `curl https://example.com/i.sh | sh`
- WHEN se clasifica
- THEN el sub-comando `sh` (sin argumentos) coincide con la regla de intérprete desnudo y la severidad general es `high`

#### Scenario: Un intérprete invocado con un argumento de script explícito no coincide

- GIVEN el comando `python3 build.py`
- WHEN se clasifica
- THEN la regla de intérprete desnudo no coincide (args no está vacío); la severidad permanece en `low` a menos que otra regla coincida

### Requirement: Los Subcomandos Destructivos de Docker Escalan

El sistema DEBE clasificar `docker system prune -a --volumes` como `high`, y DEBE clasificar `docker rmi -f` o `docker volume rm` como `medium`.

#### Scenario: docker system prune con todas las flags

- GIVEN el comando `docker system prune -a --volumes`
- WHEN se clasifica
- THEN la severidad es `high`

#### Scenario: docker rmi -f

- GIVEN el comando `docker rmi -f myimage:latest`
- WHEN se clasifica
- THEN la severidad es `medium`

#### Scenario: docker volume rm

- GIVEN el comando `docker volume rm myvolume`
- WHEN se clasifica
- THEN la severidad es `medium`

### Requirement: Las Sentencias Destructivas Inline de CLI de Bases de Datos Escalan a High

El sistema DEBE clasificar las invocaciones de `psql -c` o `mysql -e` cuyo argumento de sentencia inline contenga `DROP`, `TRUNCATE`, o un `DELETE FROM` no calificado (es decir, `DELETE` sin cláusula `WHERE`) como `high`. La coincidencia se basa en heurística/subcadena sobre el texto de la sentencia inline — esto es una heurística v1, no un parser SQL, y no hay ninguna tabla de identificadores de base de datos protegidos (análoga a `GIT_PROTECTED_BRANCHES`) que la controle.

#### Scenario: DROP TABLE inline en psql

- GIVEN el comando `psql -c "DROP TABLE users"`
- WHEN se clasifica
- THEN la severidad es `high`

#### Scenario: DELETE no calificado inline en mysql

- GIVEN el comando `mysql -e "DELETE FROM users"`
- WHEN se clasifica
- THEN la severidad es `high`

#### Scenario: Una consulta inline de solo lectura en psql no coincide

- GIVEN el comando `psql -c "SELECT 1"`
- WHEN se clasifica
- THEN la severidad permanece en `low`

### Requirement: Los Ejecutables y Argumentos No-Git Sin Coincidencia Permanecen en Low

Un ejecutable sin entrada en `NON_GIT_RULES`, o un sub-comando no-git cuyos argumentos no coinciden con ninguna regla para su ejecutable, DEBE clasificarse como `low` — idéntico al valor por defecto existente de "ninguna regla coincidió" de `GIT_RULES`. El sistema NO DEBE aplicar ninguna heurística genérica de flags destructivas ni ningún tier de respaldo general para ejecutables no reconocidos.

#### Scenario: Ejecutable sin entrada de regla

- GIVEN el comando `ls -la /`
- WHEN se clasifica
- THEN la severidad es `low`

#### Scenario: Ejecutable reconocido, sin argumentos coincidentes

- GIVEN el comando `cargo build`
- WHEN se clasifica
- THEN la severidad es `low`

#### Scenario: La clasificación de git existente no se ve afectada

- GIVEN el comando `git push --force origin main`
- WHEN se clasifica
- THEN sigue siendo despachado a través de `GIT_RULES` y se clasifica como `critical`, sin cambios por esta capacidad

## Non-Scope

Lo siguiente está explícitamente fuera del alcance de esta capacidad y NO DEBE implementarse como parte de ella:

- No se incluye `PROTECTED_DB_NAME_PATTERNS` (ni ninguna tabla de identificadores de base de datos protegidos) simétrica a `GIT_PROTECTED_BRANCHES` — se difiere a un cambio futuro.
- No hay cambios en `command-parser.ts` ni en `tokenizer.ts` — la regla de intérprete desnudo con pipe a shell se implementa enteramente como un predicado en `severity.ts` sobre el sub-comando de intérprete sin argumentos.
- No hay cambios en `proposed-action.ts` ni en `allowlist.ts`.
- No hay una excepción de tier medium basada en la amplitud de la ruta para `rm -rf` — se clasifica como `high` incondicionalmente sin importar el alcance del objetivo.
- No hay ninguna heurística de respaldo general para ejecutables que no coinciden con ninguna regla; se clasifican como `low`, igual que hoy.
- `kubectl`, `npm publish`, `twine upload` — no hay superficie de k8s ni de registro de paquetes en este repositorio.

## Result Contract

- `status`: `done`
- `executive_summary`: Delta spec que agrega una capacidad `non-git-threat-matrix` (9 requirements, 22 scenarios) que extiende el clasificador de severidad de MAGI, hoy limitado a git, a 8 familias de ejecutables/patrones no-git destructivos, despachados desde el mismo punto `classifySubCommand` mediante una nueva tabla `NON_GIT_RULES`, preservando explícitamente el valor por defecto "sin coincidencia permanece en low".
- `artifacts`: `openspec/changes/magi-severity-nongit-threat-matrix/specs/non-git-threat-matrix/spec.md`, Engram `sdd/magi-severity-nongit-threat-matrix/spec`
- `next_recommended`: `sdd-design`
- `risks`: (1) Las decisiones confirmadas anulan explícitamente el tier de `rm -rf` (siempre `high`, sin división por amplitud) y confirman `chmod -R`/`chown -R` en `high` con una condición de ruta amplia, pero no se pronuncian sobre los tiers de `dd`/`mkfs*`/`shred`/`docker`/CLI de bases de datos — este spec conserva los tiers de esas cinco familias sin cambios respecto de la propuesta (dd: `critical` para `/dev/*`, si no `high`; `mkfs*`: `critical`; `shred`: `high`; `docker system prune -a --volumes`: `high`; `docker rmi -f`/`volume rm`: `medium`; CLI de bases de datos: `high`) ya que no se dio ninguna instrucción en contrario. (2) La coincidencia de "DELETE no calificado" en CLI de bases de datos (sin cláusula `WHERE`) es un detalle interpretativo a nivel de spec que no está especificado textualmente en la propuesta; se marca aquí para que diseño confirme la heurística exacta (ausencia de subcadena `WHERE`, sin distinción de mayúsculas/minúsculas).

## Key Learnings

1. Las decisiones de alcance confirmadas anulan la división propia de la propuesta entre critical/high según la amplitud para `rm -rf`, haciendo que `rm -rf` se clasifique como `high` incondicionalmente, sin ninguna excepción de medium ni critical.
2. `chmod -R`/`chown -R` conserva una condición de ruta amplia (coincidiendo con `/`, `~`, `$HOME`, `.`, `..`, `*`) a diferencia de `rm -rf`, por lo que un `chmod -R` acotado dentro del repositorio sigue cayendo en el valor por defecto de "sin coincidencia permanece en low".
3. La regla de intérprete desnudo con pipe a shell es un predicado exclusivo de `severity.ts` sobre un sub-comando de intérprete sin argumentos, porque el tokenizador ya divide `|` en sub-comandos independientes antes de que `classifySubCommand` llegue siquiera a verlos.
4. `NON_GIT_RULES` es estructuralmente idéntica al arreglo `GIT_RULES` existente (predicados `{ id, matches, tier }`), despachada desde la misma función `classifySubCommand` que actualmente deriva los ejecutables no-git directamente a `low`.
5. Las cinco familias de la propuesta no mencionadas en las decisiones de alcance confirmadas (dd, mkfs, shred, docker, CLI de bases de datos) conservan sus tiers originalmente propuestos sin cambios, ya que las decisiones confirmadas solo revisaron explícitamente `rm -rf` y `chmod`/`chown`.

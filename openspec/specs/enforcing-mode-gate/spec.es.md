> Traducción de `spec.md`. En caso de discrepancia, el archivo en inglés es la fuente de verdad.

# Especificación del Gate de Modo de Aplicación (Enforcing)

## Propósito

Define cómo MAGI resuelve su modo de operación y cómo el adaptador del hook PreToolUse debe efectivamente bloquear una llamada a herramienta cuando el consenso calcula un veredicto `deny` en modo de aplicación (enforcing).

## Requirements

### Requirement: Fuente Única del Modo

El sistema DEBE resolver `mode` exclusivamente a partir de la variable de entorno `MAGI_MODE`. `magi.config.json` NO DEBE contener una clave `mode`, y `MagiConfig`/`DEFAULT_CONFIG` NO DEBEN exponer un campo `mode`.

#### Scenario: MAGI_MODE no configurado

- GIVEN `MAGI_MODE` no está configurado en el entorno
- WHEN `resolveMode()` se ejecuta
- THEN el modo se resuelve a `shadow`

#### Scenario: MAGI_MODE configurado como enforced

- GIVEN `MAGI_MODE=enforced` está configurado en el entorno
- WHEN `resolveMode()` se ejecuta
- THEN el modo se resuelve a `enforced`

#### Scenario: El archivo de configuración no tiene efecto sobre el modo

- GIVEN `magi.config.json` no contiene ninguna clave `mode` (según el schema)
- WHEN la CLI carga la configuración
- THEN ninguna ruta de código lee un valor `mode` del objeto de configuración

### Requirement: El Modo de Aplicación Bloquea los Veredictos de Denegación

El sistema DEBE bloquear la llamada a la herramienta cuando `mode === 'enforced'` y la `decision` del veredicto ensamblado sea `'deny'`. Cuando `mode !== 'enforced'`, o el veredicto es `allow`, el comportamiento DEBE permanecer sin cambios respecto al comportamiento actual del modo shadow (siempre reportar `allow` a Claude Code).

#### Scenario: El modo enforced bloquea un veredicto de denegación

- GIVEN el modo se resuelve a `enforced`
- AND el consenso ensambla un veredicto con `decision: 'deny'`
- WHEN el adaptador del hook PreToolUse se ejecuta
- THEN el adaptador del hook comunica a Claude Code un resultado de denegación/bloqueo de modo que la llamada a la herramienta no procede

#### Scenario: El modo enforced no afecta un veredicto de permiso

- GIVEN el modo se resuelve a `enforced`
- AND el consenso ensambla un veredicto con `decision: 'allow'`
- WHEN el adaptador del hook PreToolUse se ejecuta
- THEN la llamada a la herramienta procede, idéntico al modo shadow

#### Scenario: El modo shadow nunca bloquea

- GIVEN el modo se resuelve a `shadow`
- AND el consenso ensambla un veredicto con `decision: 'deny'`
- WHEN el adaptador del hook PreToolUse se ejecuta
- THEN la llamada a la herramienta procede (allow), y el veredicto de denegación se registra únicamente en el log de auditoría

### Requirement: El Bloqueo Incluye el Fundamento Completo de los Evaluadores

Cuando el modo de aplicación bloquea una acción, la razón comunicada de vuelta a Claude Code DEBE incluir el fundamento completo de los tres evaluadores (Melchior, Balthasar, Casper) — no solo la decisión agregada y una referencia al log de auditoría.

#### Scenario: La razón de bloqueo incluye todos los fundamentos de los evaluadores

- GIVEN el modo se resuelve a `enforced`
- AND el consenso ensambla un veredicto con `decision: 'deny'` a partir de las evaluaciones de Melchior, Balthasar y Casper
- WHEN el adaptador del hook construye la razón del bloqueo
- THEN el texto de la razón incluye el veredicto individual y el fundamento de cada evaluador para esta acción

### Requirement: El Registro de Auditoría No Se Ve Afectado Por el Modo

El sistema DEBE continuar escribiendo un registro de auditoría para cada acción evaluada sin importar el modo, sin cambios según si la acción fue bloqueada o permitida.

#### Scenario: Un bloqueo en modo enforced sigue siendo auditado

- GIVEN el modo se resuelve a `enforced` y el veredicto es `deny`
- WHEN el adaptador del hook bloquea la llamada a la herramienta
- THEN se agrega un registro de auditoría para la denegación a la cadena de hash, igual que en modo shadow

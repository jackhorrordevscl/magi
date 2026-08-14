> Traducción de `spec.md`. En caso de discrepancia, el archivo en inglés es la fuente de verdad.

# Especificación de Anulación Humana Auditada

## Propósito

Define la CLI `magi audit override`: cómo un operador documenta que una denegación registrada previamente debe ser desestimada, sin nunca mutar la cadena de auditoría a prueba de manipulaciones y sin otorgar ningún efecto automático de allowlist o reintento.

## Requirements

### Requirement: La Anulación Apunta a un Registro Por Hash

La CLI de anulación DEBE identificar el registro objetivo por su `hash` de contenido, no por `seq`.

#### Scenario: Anulación con un hash válido

- GIVEN una cadena de auditoría contiene un registro con hash `abc123`
- WHEN el operador ejecuta `magi audit override abc123 --reason "..."`
- THEN la CLI resuelve el registro objetivo haciendo coincidir `hash === "abc123"`

#### Scenario: Anulación con un hash desconocido

- GIVEN ningún registro de auditoría tiene hash `doesnotexist`
- WHEN el operador ejecuta `magi audit override doesnotexist --reason "..."`
- THEN la CLI falla con error y no escribe ningún registro nuevo

### Requirement: La Razón Es Obligatoria

La CLI de anulación DEBE requerir un argumento `--reason` no vacío y DEBE negarse a ejecutar sin él.

#### Scenario: Razón faltante

- GIVEN un hash objetivo válido
- WHEN el operador ejecuta `magi audit override <hash>` sin `--reason`
- THEN la CLI falla con error y no escribe ningún registro nuevo

#### Scenario: Razón vacía

- GIVEN un hash objetivo válido
- WHEN el operador ejecuta `magi audit override <hash> --reason ""`
- THEN la CLI falla con error y no escribe ningún registro nuevo

#### Scenario: Razón válida persistida

- GIVEN un hash objetivo válido y `--reason "operator verified manually"`
- WHEN la anulación tiene éxito
- THEN el registro de anulación agregado incluye ese texto de razón

### Requirement: Solo los Registros de Denegación Son Anulables

La CLI de anulación DEBE validar que la `decision` del registro objetivo sea `deny`. Si la decisión del registro objetivo es `allow`, la CLI DEBE fallar con error y no escribir nada.

#### Scenario: Anulando un registro de denegación

- GIVEN el registro objetivo tiene `decision: 'deny'`
- WHEN el operador ejecuta un comando de anulación válido
- THEN la CLI agrega un nuevo registro de anulación que referencia al objetivo

#### Scenario: Anular un registro de permiso es rechazado

- GIVEN el registro objetivo tiene `decision: 'allow'`
- WHEN el operador ejecuta `magi audit override <hash> --reason "..."`
- THEN la CLI falla con error y no escribe ningún registro nuevo

### Requirement: La Anulación Es de Solo Agregado y No Mutante

El sistema DEBE registrar una anulación como un nuevo registro encadenado por hash agregado al log de auditoría. El sistema NO DEBE mutar los bytes, el hash, ni ningún registro posterior en la cadena del registro denegado original.

#### Scenario: El registro original no cambia tras la anulación

- GIVEN existe un registro denegado en la cadena
- WHEN un operador lo anula exitosamente
- THEN los bytes y el hash del registro original permanecen sin cambios
- AND `magi audit verify` sigue pasando para la cadena completa

#### Scenario: El registro de anulación enlaza con el original

- GIVEN un registro denegado con hash `abc123`
- WHEN se agrega la anulación
- THEN el nuevo registro referencia `abc123` (el registro anulado) en su propio contenido

### Requirement: La Anulación Es Solo Documental

Un registro de anulación NO DEBE crear ninguna entrada de allowlist y NO DEBE disparar un reintento automático de la acción original. La acción bloqueada solo procede si el operador la reintenta por separado (por ejemplo, tras cambiar a modo shadow, o una vez resuelta la condición de bloqueo).

#### Scenario: La anulación no vuelve a ejecutar la acción

- GIVEN un operador anula un registro denegado
- WHEN el comando de anulación se completa
- THEN no se re-ejecuta ninguna llamada a herramienta y no se crea ninguna entrada de allowlist como efecto secundario

### Requirement: La Contabilidad de la Tasa de Denegación No Se Ve Afectada Por la Anulación

La métrica de tasa de denegación de `magi audit stats` DEBE continuar clasificando el registro denegado original como una denegación. Una anulación NO DEBE reclasificarlo como permitido.

#### Scenario: La tasa de denegación incluye la denegación anulada

- GIVEN un registro denegado fue posteriormente anulado
- WHEN `magi audit stats` calcula la tasa de denegación
- THEN el registro original sigue contando dentro del reparto de denegaciones

### Requirement: El Conteo de Anulaciones Se Reporta Por Separado

`magi audit stats` DEBE reportar el conteo/tasa de anulaciones como una métrica distinta del reparto de decisiones allow/deny.

#### Scenario: Las estadísticas muestran el conteo de anulaciones

- GIVEN el log de auditoría contiene 5 registros de denegación y 2 registros de anulación
- WHEN el operador ejecuta `magi audit stats`
- THEN la salida reporta 5 denegaciones en el reparto de decisiones y 2 anulaciones como una métrica separada

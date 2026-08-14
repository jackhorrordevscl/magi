> Traducción de `spec.md`. En caso de discrepancia, el archivo en inglés es la fuente de verdad.

# Especificación de Evaluadores Multi-Proveedor

## Propósito

Define el comportamiento de `GeminiEvaluator`, un nuevo backend de `EvaluatorPort` que llama a la API de Gemini de Google, de modo que sea intercambiable con `AnthropicEvaluator` y `GroqEvaluator` bajo el mismo contrato: votación forzada mediante tool-call, con fallo cerrado (fail-closed) a `deny` ante cualquier salida no conforme.

## Requirements

### Requirement: Forma de la Solicitud a Gemini

El sistema DEBE construir una solicitud `generateContent` de Gemini usando `contents` para el prompt y una única herramienta de function-call forzada.

El cuerpo de la solicitud DEBE incluir `tools: [{ functionDeclarations: [...] }]` describiendo una función `cast_vote`, y DEBE establecer `toolConfig: { functionCallingConfig: { mode: 'ANY' } }` para forzar exactamente una llamada a herramienta.

#### Scenario: La solicitud fuerza una única llamada a herramienta

- GIVEN un `GeminiEvaluator` construido con un `GeminiClient` simulado
- WHEN se invoca `castVote` para una acción propuesta
- THEN la solicitud pasada al cliente contiene `tools[0].functionDeclarations[0].name === 'cast_vote'`
- AND `toolConfig.functionCallingConfig.mode === 'ANY'`

### Requirement: Encabezado de Autenticación

El sistema DEBE autenticarse ante Gemini usando el encabezado `x-goog-api-key`, no `Authorization: Bearer`.

El sistema DEBE usar por defecto `process.env.GEMINI_API_KEY` como clave de API cuando no se suministra una opción explícita `apiKey` y no se inyecta ningún `client` simulado.

#### Scenario: El cliente por defecto envía x-goog-api-key

- GIVEN un `GeminiEvaluator` construido sin un `client` inyectado
- WHEN `castVote` dispara el cliente por defecto basado en `fetch`
- THEN los encabezados de la solicitud saliente incluyen `x-goog-api-key` establecido a la clave de API resuelta
- AND no se envía ningún encabezado `Authorization`

### Requirement: URL Base e Interpolación del Modelo

El sistema DEBE tratar `GeminiEvaluatorOptions.baseUrl` como una ruta base, no como un endpoint completo, y DEBE interpolar el nombre del modelo en la ruta de la solicitud como `{baseUrl}/v1beta/models/{model}:generateContent`.

El sistema DEBE usar por defecto el modelo `gemini-2.5-flash-lite` cuando no se suministra ninguna opción `model`.

#### Scenario: El cliente por defecto interpola el modelo en la ruta

- GIVEN un `GeminiEvaluator` construido con `model: 'gemini-2.5-flash-lite'` y un `baseUrl` por defecto
- WHEN el cliente por defecto emite la solicitud
- THEN la URL de la solicitud termina con `/v1beta/models/gemini-2.5-flash-lite:generateContent`

### Requirement: Extracción del Voto a Partir de Argumentos Parseados

El sistema DEBE extraer el voto desde `candidates[0].content.parts[].functionCall` donde `args` ya es un objeto parseado, y NO DEBE intentar hacer `JSON.parse` sobre `args`.

El sistema DEBE validar el `args` extraído contra el mismo schema de `cast_vote` (`vote`, `rationale`) usado por los demás evaluadores.

#### Scenario: Una llamada a función bien formada produce un voto

- GIVEN un `GeminiClient` simulado que devuelve un `candidates[0].content.parts[0].functionCall` con `name: 'cast_vote'` y `args: { vote: 'allow', rationale: 'looks safe' }`
- WHEN `castVote` procesa la respuesta
- THEN el `Vote` resultante tiene `vote: 'allow'` y `rationale: 'looks safe'`

#### Scenario: Un objeto args malformado falla en modo cerrado

- GIVEN un `GeminiClient` simulado que devuelve un `functionCall.args` que no cumple con el schema de `cast_vote` (por ejemplo, falta `rationale`, o `vote` está fuera del enum)
- WHEN `castVote` procesa la respuesta
- THEN el `Vote` resultante es `deny`
- AND el fundamento indica fallo cerrado por validación de schema, no que se intentó una reparación o reintento

### Requirement: Fallo Cerrado Ante Llamada a Herramienta Ausente o No Conforme

El sistema DEBE devolver un voto `deny` cuando la respuesta no contiene ningún `functionCall`, o cuando un `functionCall` tiene un `name` distinto de `cast_vote`.

#### Scenario: Sin llamada a función en la respuesta

- GIVEN un `GeminiClient` simulado que devuelve una respuesta sin ninguna parte `functionCall`
- WHEN `castVote` procesa la respuesta
- THEN el `Vote` resultante es `deny` con un fundamento que describe la ausencia de la llamada a herramienta

#### Scenario: Nombre de función incorrecto

- GIVEN un `GeminiClient` simulado que devuelve un `functionCall` con `name` distinto de `cast_vote`
- WHEN `castVote` procesa la respuesta
- THEN el `Vote` resultante es `deny`

### Requirement: Fallo Cerrado Ante Falla de Transporte y Timeout

El sistema DEBE devolver un voto `deny` cuando la solicitud subyacente lanza una excepción (error de red, estado HTTP no-2xx) o es abortada tras transcurrir `timeoutMs` (por defecto `2500`).

El sistema NO DEBE reintentar ni reparar una solicitud fallida; cada llamada a `castVote` intenta exactamente una solicitud.

#### Scenario: Estado HTTP no-2xx

- GIVEN un `GeminiClient` simulado cuyo `create` rechaza porque el estado de la respuesta no fue 2xx
- WHEN `castVote` procesa el fallo
- THEN el `Vote` resultante es `deny` con un fundamento que describe el error de transporte

#### Scenario: La solicitud excede el timeout

- GIVEN un `GeminiEvaluator` con `timeoutMs: 2500` y un cliente que nunca resuelve antes de que se dispare la señal de aborto
- WHEN se invoca `castVote`
- THEN la solicitud es abortada y el `Vote` resultante es `deny`

### Requirement: Sin Validación del ID del Modelo

El sistema NO DEBE validar la opción `model` contra una lista de modelos conocidos en el momento de la construcción.

Un ID de modelo inválido o obsoleto DEBE manifestarse únicamente como una respuesta no-2xx del proveedor, manejada por la ruta existente de error de transporte con fallo cerrado — de manera consistente con `AnthropicEvaluator` y `GroqEvaluator`.

#### Scenario: Un ID de modelo inválido no es rechazado en la construcción

- GIVEN `new GeminiEvaluator('melchior', facet, { model: 'not-a-real-model' })`
- WHEN se construye el evaluador
- THEN la construcción tiene éxito sin lanzar excepción
- AND el modelo inválido solo se manifiesta más tarde como una falla de transporte no-2xx que falla en modo cerrado a `deny`

### Requirement: Conformidad con EvaluatorPort

El sistema DEBE implementar `EvaluatorPort` de modo que `GeminiEvaluator` sea sustituible en cualquier lugar donde se use `AnthropicEvaluator` o `GroqEvaluator`, sin cambiar el backend por defecto de `melchior`, `balthasar` ni `casper`.

#### Scenario: Construcción como reemplazo directo

- GIVEN `new GeminiEvaluator('balthasar', BALTHASAR_FACET, { apiKey: 'test-key' })`
- WHEN se pasa a `MainDeps.evaluators` o a `runHook`
- THEN satisface `EvaluatorPort` sin ningún error de tipo o de ejecución

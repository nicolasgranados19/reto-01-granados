# SOLUCION.md · Reto 01 · Agente de Registro como Proveedor

## 1. Problema en una frase

La analista administrativa de Periferia transcribe a mano, 8 a 12 veces al mes, los mismos datos de la empresa en formularios Excel, PDF o portales de clientes de cinco países, con riesgo de error en datos sensibles (NIT, cuenta bancaria) y dependencia de una sola persona; el agente prepara el formulario y el paquete y deja la firma y el envío a un humano.

## 2. Arquitectura

```
 Front (web/index.html, chat)
   | HTTP  POST /api/chat
   v
 Backend Hono (src/server.ts)
   |-- Ciclo del agente (src/agent/loop.ts) <--> LlmAdapter (src/llm/openai-compatible.ts) --> Groq/Gemini
   |        system prompt = agent/prompt.md + src/knowledge/*.md
   v
 Registry (src/agent/registry.ts): valida args con zod, nunca lanza
   v
 Herramientas (src/tools/proveedor.ts) --> fixtures/ (solo lectura)
                                       --> out/<caso>/ (escritura: formulario, paquete, log.jsonl)
```

| Capa | Dónde vive |
|---|---|
| Comportamiento | `agent/prompt.md` |
| Conocimiento | `src/knowledge/registro-proveedor.md` |
| Ejecución | `src/tools/proveedor.ts` |

Un cambio de reglas de negocio toca las herramientas y el conocimiento, no el servidor.

## 3. Ciclo del agente

- Bucle modelo, herramientas, modelo, con tope `MAX_ITERATIONS` (25). Al alcanzarlo responde con lo que tiene y lo que falta.
- Tope de tokens por sesión `MAX_TOKENS_SESSION` (200000).
- Confirmación humana impuesta por diseño: si el modelo llama una herramienta con `confirmado: true`, el loop solo lo permite si el último mensaje del usuario contiene una palabra de confirmación (sí, confirmo, procede, envía...). Si no, fuerza `confirmado: false` y lo registra. Además `proveedor_simular_envio` rechaza `confirmado: false` con "requiere confirmación explícita".
- El registry valida los argumentos con zod antes de ejecutar y devuelve el error al modelo como resultado de la herramienta.
- Cada llamada queda en la sesión (memoria y `out/sessions/<id>.json`) y en `out/log.jsonl`; las herramientas escriben además `out/<caso>/log.jsonl` (RN5).
- Errores o timeouts del LLM se convierten en un mensaje claro en el chat; la sesión no muere.

## 4. Elección del modelo

Proveedor y modelo configurables por variables de entorno (`LLM_BASE_URL`, `LLM_MODEL`) mediante un endpoint compatible con OpenAI; por defecto Groq o Gemini en free tier. Razón: costo cero para la prueba, soporte de tool calling y cambio de proveedor sin tocar el loop.

Costo estimado por caso (precios a verificar):

| Escenario | Tokens aprox. por caso | Costo |
|---|---|---|
| Free tier (Groq / Gemini) | ~15 000 entrada + ~2 000 salida | USD 0 |
| Modelo de pago pequeño (precio a verificar, ~USD 0.15 / 1M entrada y ~0.60 / 1M salida) | idem | ~USD 0.004 |

El prompt más el conocimiento se reenvían en cada iteración; los argumentos mínimos reducen tokens.

## 5. Diseño del portal web (7.4)

**Estrategia.** Un navegador controlado (Playwright) operado en modo asistido: el agente no corre solo, prepara un guion de campos a partir de `valores-portal.md` y rellena el formulario en una sesión que el humano abre y supervisa. Alternativas: RPA tradicional (más frágil ante cambios) y extensión de navegador que rellena campos desde un JSON (menor superficie, aprobable por TI).

**Límites.** CAPTCHA y MFA no se automatizan: los resuelve el humano. Los cambios de layout rompen selectores; se mitigan con selectores por etiqueta accesible y detención ante un campo no encontrado, reportándolo en lugar de adivinar. Subida de soportes: el humano adjunta o confirma cada archivo del paquete.

**Credenciales.** Nunca en el repo, el prompt ni los logs. Viven en un gestor de secretos (o en el navegador del humano) y las ingresa el humano. El agente nunca las ve ni las recibe en el chat.

**Reparto.**

| Paso | Agente | Humano |
|---|---|---|
| Leer solicitud y mapear valores | Sí | Revisa |
| Generar `valores-portal.md` y guion | Sí | Revisa |
| Iniciar sesión (usuario, contraseña, MFA, CAPTCHA) | No | Sí |
| Rellenar campos en pantalla | Propone/ejecuta asistido | Supervisa |
| Clic en "Enviar" | No | Sí |

En este reto solo se implementa `valores-portal.md` y la respuesta "formato no soportado".

## 6. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Bun + Hono con HTML plano, un único proceso | Next.js (front y API en un framework) | Sin build step, arranque en segundos y menos piezas que explicar en 90 minutos. |
| SDK `openai` contra endpoint compatible, con interfaz `LlmAdapter` propia | Vercel AI SDK | Controlar el loop y la confirmación a mano es el objeto de evaluación; el SDK ocultaría esa lógica y añade dependencia. |
| Lógica de negocio solo en las herramientas, con argumentos mínimos (`caso`) | Que el modelo arme el mapeo y lo pase como argumento | Reduce tokens y elimina la posibilidad de que el modelo invente o altere valores (CA2). |
| Confirmación impuesta en el loop (regex sobre el último mensaje del usuario) | Confiar solo en el prompt | Un modelo puede ignorar el prompt; el diseño lo hace innecesario (CA3, RN4). |
| PDF generado con pdf-lib | Rellenar un AcroForm | El PRD acepta PDF generado y evita depender de plantillas binarias. |

## 7. Supuestos

- `fecha_referencia` (YYYY-MM-DD) es parámetro opcional de las herramientas que evalúan vigencia; por defecto es la fecha de hoy. La demo usa 2026-09-03 para ser determinista.
- `mapeo` y `campos` son opcionales: si no se envían, las herramientas releen la plantilla del caso.
- La coincidencia aproximada de etiquetas usa similitud de Jaccard con umbral 0.6; por debajo de 0.8 de confianza el campo queda en `requiere_confirmacion`.
- La nota de moneda se incluye siempre cuando aplica a campos monetarios.
- Etiquetas ambiguas de identificación tributaria pasan siempre a `requiere_confirmacion`, con el equivalente del país propuesto.
- El paquete copia también los soportes vencidos, marcados como vencidos en el checklist.
- Campos por confirmar o faltantes no bloquean `listo_para_firma` (solo soportes vencidos o ausentes, RN3).
- `proveedor_simular_envio` escribe `ENVIO-SIMULADO.md` con una advertencia si el paquete no está listo para firma.
- El nombre del caso solo admite `[a-z0-9-]` para evitar rutas fuera de `fixtures/` y `out/`.
- Los tests corren sobre una copia de los fixtures, que nunca se modifican.
- El repositorio maestro está actualizado; en producción necesita dueño del dato.

## 8. Cobertura

| HU | Estado | Notas / qué falta para producción |
|---|---|---|
| HU-1 Leer la solicitud | Hecho | Etiquetas ambiguas reportadas como requiere_confirmacion. Falta leer adjuntos reales y correo. |
| HU-2 Mapear campos | Hecho | Glosario y Jaccard; falta curación continua del glosario. |
| HU-3 Generar formulario | Parcial | xlsx y pdf hechos; portal solo diseño y `valores-portal.md`. |
| HU-4 Armar paquete | Hecho | Checklist, borrador de correo y confirmación; el envío es simulado. |
| HU-5 Manejo de errores | Hecho | Herramientas nunca lanzan; errores claros. |
| Bonus `modulo/` | No hecho | Recortado por tiempo; el script `modulo` existe en package.json sin implementar. |

Para producción: integrar correo, repositorio documental y firma electrónica, autenticación, y observabilidad.

## 9. Uso de IA

- **Claude (claude.ai):** análisis del PRD, plan de trabajo y decisiones de diseño.
- **Claude Code:** orquestador con subagentes en paralelo para implementar los tres retos; yo verifiqué los gates corriendo los comandos.
- **Descartado:** Vercel AI SDK (oculta el loop y la confirmación), Next.js (build y complejidad innecesarios) y Vercel como hosting (tiempo de ejecución serverless poco adecuado para un servidor Bun con sesiones en memoria y escritura en disco).

## 10. Riesgos

| Riesgo | Mitigación |
|---|---|
| El modelo completa un campo faltante con un valor plausible | Herramientas como única fuente de valores, prompt que lo prohíbe, faltantes explícitos. |
| Envío o acción externa sin autorización | Confirmación impuesta en el loop y en la herramienta; el humano firma y envía. |
| Soportes vencidos no detectados | Vigencia evaluada por herramienta con fecha de referencia; bloquea `listo_para_firma`. |
| Gasto descontrolado de la clave | Tope de iteraciones y de tokens por sesión; clave solo en el backend. |
| Datos sensibles (cuenta bancaria) filtrados | RN2: solo si la plantilla lo pide y nunca en el borrador de correo; logs sin valores. |
| Maestro desactualizado | Dueño del dato y revisión periódica. |
| Portales con CAPTCHA, MFA o cambios de layout | El humano opera el portal; el agente solo prepara valores. |
| Sesiones en memoria y disco local | En producción, almacenamiento externo y autenticación. |

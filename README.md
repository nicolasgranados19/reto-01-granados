# Reto 01 · Agente de Registro como Proveedor

Agente conversacional que lee la solicitud de un cliente, llena el formulario (xlsx, pdf o valores para portal) desde el repositorio maestro y arma el paquete para firma. Nunca firma ni envía: pide confirmación y el "envío" solo escribe `ENVIO-SIMULADO.md`.

Link de prueba: PENDIENTE_URL

## Levantar en local

```bash
bun install
cp .env.example .env   # completar variables (ver abajo)
bun run dev            # http://localhost:3000
```

Con Docker: `docker build -t reto-01 . && docker run -p 3000:3000 --env-file .env reto-01`.

## Variables de entorno

| Variable | Descripción |
|---|---|
| `LLM_PROVIDER` | Nombre del proveedor (informativo, ej. groq) |
| `LLM_BASE_URL` | Endpoint OpenAI-compatible |
| `LLM_API_KEY` | Clave (solo backend, nunca se expone) |
| `LLM_MODEL` | Modelo a usar |
| `LLM_TIMEOUT_MS` | Timeout al proveedor (default 30000) |
| `MAX_ITERATIONS` | Tope de iteraciones herramienta-modelo por turno (default 25) |
| `MAX_TOKENS_SESSION` | Tope de tokens por sesión (default 200000) |
| `PORT` | Puerto (default 3000) |

## Demo sin modelo

```bash
bun run demo
```

Ejecuta las herramientas sobre todos los casos con fecha fija 2026-09-03; no requiere claves. Limpia `out/` al inicio.

## Tests

```bash
bun test
```

## API

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls, needsConfirmation }` |
| GET | `/api/sessions/:id` | Historial de la sesión |
| GET | `/api/health` | `{ ok, provider, model }` (sin claves) |
| POST | `/api/reset` | Borra `out/` |

Prompt de ejemplo: `Procesa el caso "ec-corp-andina". No envíes nada todavía.`

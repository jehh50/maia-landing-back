# MaIA Landing — Server

Backend Node.js (Express) para el formulario de contacto / demo de la landing.

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/api/contact` | Crea un lead (nombre, empresa, email, teléfono, mensaje, tipo) |
| `GET`  | `/api/health`  | Health check |

### Payload `POST /api/contact`

```json
{
  "nombre": "Ana Pérez",
  "empresa": "Acme",
  "email": "ana@acme.com",
  "telefono": "+52 55 1234 5678",
  "mensaje": "Quiero un demo",
  "tipo": "demo"   // "demo" | "email" | "contacto"
}
```

Respuesta `201`:

```json
{ "ok": true, "id": 42 }
```

## Persistencia

PostgreSQL externo vía `pg` (Pool). Conexión por `DATABASE_URL`; esquema configurable vía `DB_SCHEMA` (default `public`). El servidor llama a `ensureSchema()` al arrancar (idempotente — crea tabla `leads` e índices si no existen).

## Correo

Vía **Nodemailer** sobre SMTP. Configurar `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` en `.env` y asegurarse de que `MAIL_FROM` esté autorizado en tu proveedor SMTP. Si `SMTP_HOST` está vacío, el envío se omite y solo se guarda el lead en DB. Si falla con SMTP configurado, se loggea pero la request sigue siendo `201` (best-effort).

`sendLead()` devuelve `{ status: 'sent' | 'skipped' | 'failed', ... }`. El log estructurado va a la salida del server con prefijo `[mail]`; la respuesta JSON al cliente sigue siendo `{ ok, id }` (sin filtrar info interna).

## Desarrollo

```bash
cp .env.example .env
npm install
npm run dev        # arranca en http://localhost:3001
npm test           # corre tests con vitest (requiere Postgres accesible)
```

## Documentación

| Archivo | Qué contiene |
|---|---|
| `docs/architecture.md` | Cómo está construido el sistema y por qué |
| `docs/context.md` | Contexto del proyecto y decisiones ya tomadas |
| `docs/conventions.md` | Estilo, patrones obligatorios y convención de Git |
| `docs/verification.md` | Cómo verificar que un cambio funciona |
| `docs/database.md` | Esquema y reglas para tocarlo |
| `docs/api-contract.md` | Contrato con el frontend |

## Trabajo con agentes de IA

Este repo lleva un arnés para agentes. Punto de entrada: **`AGENTS.md`**.
El backlog vivo está en `feature_list.json`, el estado de la sesión en
`progress/current.md`, y los criterios de cierre en `CHECKPOINT.md`.
Los subagentes (`leader`, `implementer`, `reviewer`) están en `.claude/agents/`.

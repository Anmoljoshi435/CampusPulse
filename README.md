# CampusPulse

CampusPulse is a React/Vite frontend backed by an Express, MySQL, and Socket.IO API. Complaint classification and similarity analysis run through the Python AI service.

## Deployed application

- Frontend: https://campus-pulse-h1hfvjeah-anmoljoshi435.vercel.app
- API: https://campuspulse-api-tkh3.onrender.com
- API health: https://campuspulse-api-tkh3.onrender.com/api/health

## Architecture

- `frontend/` - responsive React application
- `backend/` - Express API, bcrypt authentication, MySQL access, Socket.IO
- `backend/database/` - canonical schema, seed data, and versioned migrations
- `backend/ai/` - TF-IDF similarity/classification implementation and optional HTTP service

## Prerequisites

- Node.js 22+
- MySQL 8+
- Python 3.12+ for local AI execution
- SMTP credentials for email OTP delivery

## Local setup

```powershell
Copy-Item backend\.env.development.example backend\.env
Copy-Item frontend\.env.development.example frontend\.env
Set-Location backend
npm ci
npm run setup-db
npm run db:migrate
npm run db:seed
Set-Location ..\frontend
npm ci
```

Set a random `JWT_SECRET` of at least 32 characters and database credentials before starting the backend. Real OTP delivery requires SMTP credentials; the application never fabricates successful delivery.

Start services in separate terminals:

```powershell
Set-Location backend; npm run dev
Set-Location frontend; npm run dev
```

The Vite development proxy forwards `/api` and Socket.IO traffic to the backend. Production builds must define `VITE_API_URL` and `VITE_SOCKET_URL`.

## Database

Normal server startup does not mutate the schema. Apply migrations explicitly:

```powershell
Set-Location backend
npm run db:migrate
npm run db:seed
```

`db:seed` is for development/demo data only. Do not use it against a production database without reviewing the SQL.

## OTP and password recovery

OTP delivery is provider-backed and uses six-digit, five-minute codes with one-time use, five attempts, and a sixty-second resend cooldown. OTP hashes are stored, never plaintext codes.

Configure:

- OTP delivery: Resend (`RESEND_API_KEY`, optional `RESEND_FROM`)

Password recovery uses `/api/auth/forgot-password` followed by `/api/auth/reset-password` and returns generic request responses to avoid account enumeration.

## AI service

The backend uses the local Python process when `AI_SERVICE_URL` is empty. For an isolated service:

```powershell
python -m venv .venv
.venv\Scripts\pip install -r backend\requirements.txt
python backend\ai\service.py
```

Set `AI_SERVICE_URL` to the running service. AI failures do not block complaint creation; the API stores a safe default classification.

## Production requirements

- Set `NODE_ENV=production`, `CLIENT_URL`, `CORS_ORIGINS`, database settings, `JWT_SECRET`, `PYTHON_BIN`, and `AI_SERVICE_URL`.
- Use HTTPS and secure infrastructure for the API, frontend, database, and SMTP provider.
- Restrict CORS to known frontend origins.
- Run migrations as a release step, not during API startup.
- Use a long-running Node process for Socket.IO; do not deploy the realtime API as a serverless function.
- Keep `.env` files, `node_modules`, `dist`, Python caches, logs, and credentials out of version control.

## CI and verification

GitHub Actions runs frontend install/lint/build, backend syntax checks, and Python compilation. Local checks:

```powershell
Set-Location frontend; npm ci; npm run lint; npm run build
Set-Location ..\backend; npm ci; node --check server.js; node --check db.js
python -m py_compile backend\ai\analyze.py backend\ai\service.py
```

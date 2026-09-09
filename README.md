# CampusPulse

CampusPulse is split into an independent React frontend and Node/Express backend.

## Structure

- `frontend/` React + Vite dashboard
- `backend/` Express API, JWT auth, MySQL queries, Socket.IO
- `backend/database/` MySQL schema and seed data
- `backend/ai/` Python TF-IDF-style cosine similarity analyzer

## Run

1. Copy `backend/.env.example` to `backend/.env` and set the MySQL password and JWT secret.
2. Create tables with `cd backend; npm run setup-db`
3. Seed demo users with `npm run seed-db`
4. Install frontend: `cd frontend; npm install`
5. Install backend: `cd ../backend; npm install`
6. Start backend: `npm run dev`
7. In another terminal start frontend: `cd ../frontend; npm run dev`

Backend health check: `http://localhost:5000/api/health`

Demo seed accounts use `student@campuspulse.local` and `admin@campuspulse.local`. Change seed passwords before production use.

Each college has a row in `colleges` with its own code. The seeded Cambridge Institute of Technology community uses `CIT001`; students enter that code and the college password `college123`, then wait for an admin approval request. Admin sign-in uses the college code plus `ADMIN_ACCESS_KEY` (`12345678`) and does not require approval. Admins can review requests with `GET /api/admin/requests` and approve them with `PUT /api/admin/requests/:id`.

The frontend requests browser geolocation and uses Open-Meteo for current temperature. If permission is denied or the weather service is unavailable, it displays that state instead of invented data.

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and Oxlint's TypeScript related rules in your project.

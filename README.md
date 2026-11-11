# Prila Backend

Node.js 22 + Fastify + TypeScript (ESM) + MongoDB/Mongoose + Zod + Socket.io.

## Setup

```bash
cp .env.example .env
# edit JWT_SECRET, ADMIN_LOGINS, MONGODB_URI
npm install
npm run seed
npm run dev
```

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Watch mode |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest |
| `npm run seed` | Seed Warangal + services + configs |
| `npm run build` / `npm start` | Production |

SMS OTP provider is optional until DLT is ready (`ALLOW_OTP_DEBUG=true` returns `debugCode` in non-prod).

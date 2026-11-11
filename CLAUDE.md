# Prila Backend — Claude Code instructions

Node.js (LTS) + TypeScript + Fastify + MongoDB/Mongoose + Zod + Socket.io API for all Prila clients.

Shared workspace rules (single source of truth):

@../.cursor/rules/00-prila-core.mdc
@../.cursor/rules/01-server-driven.mdc
@../.cursor/rules/20-backend.mdc
@../.cursor/rules/40-ride-domain.mdc

Docs: `../docs/ARCHITECTURE.md`, `../docs/API_CONTRACT.md`, `../docs/CONFIG_KEYS.md`, `../docs/UI_REFERENCE.md`, `../docs/DECISIONS.md`

## Commands (after Phase 1 scaffold)

```bash
npm install
npm run dev
npm run typecheck
npm run lint
npm test
npm run seed
npm run build
npm start
```

Never commit `.env`, Firebase service-account JSON, R2 secrets, or JWT secrets. Commit `.env.example` instead.

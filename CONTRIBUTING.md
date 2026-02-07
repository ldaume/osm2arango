# Contributing

This project aims for high-signal, safe changes that keep the import pipeline evolvable.

## Engineering guidelines

- Follow `AGENTS.md` (layering, data-access rules, testing style).
- Keep changes small and reversible.
- Prefer explicit configuration and contracts over implicit magic.

## Dev setup

1. Install Bun.
2. Install dependencies:

```bash
bun install
```

3. Start ArangoDB (optional `docker-compose up`).
4. Run tests:

```bash
bun test
```

## Linting

```bash
bun run lint
bun run lint:fix
```

## Typecheck

```bash
bun run typecheck
```

## Pull requests

Include:

- What changed
- Why it matters to users
- How to test
- Known risks / trade-offs

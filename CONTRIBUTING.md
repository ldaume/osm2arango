# Contributing

This project aims for high-signal, safe changes that keep the import pipeline evolvable.

## Engineering guidelines

- Keep the CLI/transport layer thin: parse/validate input, then call domain functions.
- Keep ArangoDB access in `*.data.ts` modules (e.g. `src/arango/arango.data.ts`).
- Prefer small, deterministic tests in Given/When/Then style.
- Keep changes small and reversible; prefer explicit configuration over implicit magic.

## Dev setup

1. Install Bun.
2. Install dependencies:

```bash
bun install
```

3. Start ArangoDB (optional `docker compose up`).
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

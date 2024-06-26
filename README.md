# DOTA Indexer

DOTA indexer by community, accroding to [offical](https://github.com/DOTA-DOT20/genesis_balance) transaction valid rules.

# How to use

## Prerequisites

- Node.js
- PostgreSQL

## Installation

1. Install the dependencies

```bash
pnpm install
```

2. Generate the database schema

```bash
echo DATABASE_URL="postgresql://username:password@localhost:5432/dota" > .env
npx prisma migrate dev --name init
```

3. Run the server

```bash
pnpm build
node build/src/index.js
```
ttt

# DriftWing (Base + Farcaster Mini App)

A one-touch vertical shooter:
- Drag left/right to drift
- Auto-fire with overheat meter
- 3 enemy types + miniboss
- Score + combo multiplier
- Optional onchain personal best + score event log

## Run locally
```bash
npm i
npm run dev
```

## Deploy
Deploy to Vercel (or any Next.js host).

## REQUIRED edits after deploy (2 places)
1) `public/.well-known/farcaster.json`
   - set URLs to your deployed domain
   - add `accountAssociation` credentials (Base Build or Farcaster domain manifest tool)

2) Environment variables
   - (optional) set `NEXT_PUBLIC_APP_URL` to your deployed URL (no trailing slash)
   - (optional) set `NEXT_PUBLIC_SCOREBOARD_ADDRESS=0x...` (Base) for onchain saving

## Onchain scoreboard (optional)
This repo includes `contracts/Scoreboard.sol`.

Cheapest realistic pattern:
- store only `bestScore[address]` in storage
- emit an event for every submitted score (full history onchain via logs)

### Quick deploy via Remix
- Open Remix, create `Scoreboard.sol`, paste the contract from `contracts/Scoreboard.sol`
- Deploy to Base (mainnet or testnet)
- Copy the contract address into `.env.local`:
  - `NEXT_PUBLIC_SCOREBOARD_ADDRESS=0x...`

Then scores will AUTO-SAVE onchain on every game over (wallet will prompt each run).

## Env vars
Create `.env.local` (optional):
- `NEXT_PUBLIC_BASE_RPC_URL=https://mainnet.base.org`
- `NEXT_PUBLIC_SCOREBOARD_ADDRESS=0x...`
- `NEXT_PUBLIC_APP_URL=https://your-domain.com`

`NEXT_PUBLIC_APP_URL` is used to build the required `fc:miniapp` metadata (embed + launch button).

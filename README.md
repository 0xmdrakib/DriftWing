# Drift Wing

Drift Wing is a tiny arcade shooter built for quick survival runs on Base and Farcaster mini app clients.

**Live app:** https://driftwing.vercel.app

---

## Overview

Drift Wing is a one-touch shooter where players drag left and right, auto-fire at incoming enemies, collect powerups, and try to survive as long as possible.

The game combines a canvas-based arcade UI with a Rust/WASM game engine. Players can connect a wallet, save their best score onchain through a Base scoreboard contract, share their score through Farcaster, and compete on a weekly leaderboard.

## Features

- One-touch arcade shooter with drag-to-move controls
- Auto-fire gameplay with enemies, bullets, particles, bosses, and powerups
- Difficulty selector with **Easy**, **Medium**, and **Hard** modes
- Theme selector with multiple visual styles
- Wallet connection for web and mini app environments
- Onchain score saving on Base through a `Scoreboard` smart contract
- Personal best score reading from the deployed contract
- Weekly Top 100 leaderboard with countdown and rank display
- Leaderboard ingestion from submitted score transactions and recent contract events
- Farcaster mini app metadata, splash screen, and share flow
- Optional gasless score saving through a Base paymaster proxy
- Base Builder Code attribution support for score-save transactions

## Supported chain

- Base Mainnet

## Game behavior

### Arcade gameplay

Players control a small aircraft by dragging horizontally across the screen. The game handles shooting automatically, while the player focuses on dodging enemies, surviving waves, and collecting powerups.

The game engine supports multiple enemy types, boss waves, score progression, particles, screen shake, and powerup states such as overdrive and drones.

### Onchain score saving

After a run ends, players can connect their wallet and save the final score onchain. The app writes to a `Scoreboard` contract on Base and stores each player’s personal best score.

The contract emits a `ScoreSubmitted` event for every submitted score, allowing the app to verify saved scores and update the leaderboard.

### Weekly leaderboard

The weekly leaderboard tracks each player’s best score for the current week and shows the Top 100 players. The leaderboard can be updated from submitted transactions and synced from recent onchain `ScoreSubmitted` events.

When persistent storage is configured, leaderboard data is stored with Vercel KV or Upstash Redis. Without persistent storage, the app can still run locally with in-memory leaderboard data.

### Gasless flow

The app can optionally route score-save transactions through a server-side paymaster proxy. When the connected wallet supports paymaster capabilities, the app sends sponsored calls through `wallet_sendCalls`. If paymaster support is unavailable, it falls back to a normal wallet transaction.

## Tech stack

- Next.js 14
- React 18
- TypeScript
- Rust
- WebAssembly
- Tailwind-style custom CSS
- viem
- Farcaster Mini App SDK
- Vercel KV / Upstash Redis
- Solidity

---

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Create a `.env` file in the project root. Then copy the values from [.env.example](./.env.example) and fill them in.

### 3. Build the WASM engine when needed

The project includes a compiled WASM engine. If you change the Rust engine source, rebuild the WASM package:

```bash
npm run build:wasm
```

### 4. Run the development server

```bash
npm run dev
```

Open `http://localhost:3000` in your browser.

### 5. Build for production

```bash
npm run build
npm run start
```

## License

This project is licensed under the [MIT License](./LICENSE).

# Drift Wing

Drift Wing is a tiny arcade shooter built for quick survival runs on Base and Farcaster mini app clients.

**Live app:** https://driftwing.rakibhq.xyz

---

## Overview

Drift Wing is a one-touch shooter where players drag left and right, auto-fire at incoming enemies, collect powerups, and try to survive as long as possible.

The game combines a canvas-based arcade UI with a Rust/WASM game engine. Players can connect a wallet, save their best score onchain through a Base scoreboard contract, and share their score through Farcaster.

## Features

- One-touch arcade shooter with drag-to-move controls
- Auto-fire gameplay with enemies, bullets, particles, bosses, and powerups
- Difficulty selector with **Easy**, **Medium**, and **Hard** modes
- Theme selector with multiple visual styles
- Wallet connection for web and mini app environments
- Onchain score saving on Base through a `Scoreboard` smart contract
- Personal best score reading from the deployed contract
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

The contract emits a `ScoreSubmitted` event for every submitted score, keeping a verifiable score history onchain.

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
- Solidity

---

## License

This project is licensed under the [MIT License](./LICENSE).

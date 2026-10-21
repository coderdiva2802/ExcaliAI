# ExcaliAI

> **Interactive AI-Powered Visual Whiteboard Tutor**  
> An intelligent educational platform combining real-time Excalidraw whiteboarding, streaming LLM agents, and visual DSL execution to teach complex concepts step-by-step.

---

## Architecture Overview

ExcaliAI is structured as a Turborepo monorepo:

```
ExcaliAI/
├── apps/
│   ├── web/          # React + Vite + Excalidraw interactive canvas & UI
│   └── server/       # Node.js/Express + Prisma ORM + LLM Multi-Provider Gateway
├── packages/
│   ├── shared/       # Cross-boundary schemas, API contracts & action definitions
│   └── visual-dsl/   # Visual Domain Specific Language, AST parser & validator
└── docker-compose.yml# Containerized local services & environment
```

---

## Key Features

- **Hands-on AI Canvas Drawing:** Generates real-time sketches, geometric elements, circuit diagrams, and chemistry atoms directly onto Excalidraw.
- **Visual DSL & Action Engine:** Deterministic visual language compiled to canvas mutations with high validation safeguards.
- **Multi-Turn Interactive Lessons:** Step-by-step interactive tutor with narration, progress tracking, and knowledge-check questions.
- **Multi-Provider LLM Gateway:** Unified interface supporting OpenAI-compatible APIs, Mistral, OpenRouter, and mock fallback fixtures.
- **Real-Time Streaming:** Server-Sent Events (SSE) stream incremental visual actions and spoken narration directly to the browser.

---

## Tech Stack

- **Frontend:** React, TypeScript, Vite, Tailwind CSS, Excalidraw, Zustand, Lucide Icons
- **Backend:** Node.js, Express, TypeScript, Prisma ORM, SQLite
- **Monorepo:** Turborepo, NPM Workspaces
- **AI / LLM:** Mistral, OpenRouter, Custom Visual Planner Agents

---

## Getting Started

### Prerequisites

- Node.js (v18+ or v20+)
- npm (v9+)

### Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/anmolr2506/ExcaliAi.git
   cd ExcaliAi
   ```

2. **Install all dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment:**
   ```bash
   cp .env.example .env
   # Add your LLM API keys in .env
   ```

4. **Start the development environment:**
   ```bash
   npm run dev
   ```

---

## Collaborators

- [Anmol Ramchandani](https://github.com/anmolr2506) (`24btm005@nirmauni.ac.in`)
- [Jainish](https://github.com/jainish012006-max) (`jainish012006@gmail.com`)

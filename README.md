# Whatsapp Golem 🗿

A smart, agentic WhatsApp bot powered by LangChain and LLMs (Grok, OpenAI, etc.). It can plan interactions, transcribe audio, analyze images, and maintain context across long conversations.

## Features

- **🧠 Agentic Planning**: Uses a "Planner" agent to decide *how* to respond (Standard, Abuse check, Self-reflection).
- **🗣️ Audio Transcription**: Automatically transcribes voice notes and PTT messages.
- **👀 Vision Capabilities**: Can see and analyze images sent to it.
- **📝 Context Awareness**: Smart history fetching, including "Last Active Day" logic.
- **⚙️ Configurable**: Switch between LLM providers (OpenAI recommended, or Grok) and customize trigger words via YAML.

## Prerequisites

- Node.js (v18+)
- A WhatsApp account (linked via QR code)
- API Key for your LLM provider (recommended: `OPENAI_API_KEY`, or `XAI_API_KEY` for Grok)

## Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/whatsapp-golem.git
   cd whatsapp-golem
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure Environment**
   Create a `.env` file for your secrets:
   ```env
   OPENAI_API_KEY=sk-...
   # XAI_API_KEY=xai-... (optional, for Grok)
   ```

4. **Customize Config**
   Edit `config.yaml` to set your preferences.
   ```yaml
   bot:
     triggers: ["@golem", "@g"]
   
   models:
     planner:
       provider: "openai"
       modelName: "gpt-5.2"
   ```

## Running

```bash
npm start
```

Scan the QR code with your WhatsApp app (Linked Devices -> Link a Device).

## Architecture

- **`src/index.ts`**: Entry point, handles WhatsApp events and message routing.
- **`src/agents/planner.ts`**: Helper agent that analyzes the conversation and determines the best course of action.
- **`src/agents/executor.ts`**: Takes the plan and generates the final response using the selected Persona/Model.
- **`src/services/llmFactory.ts`**: Abstracts LLM provider creation.

## License

MIT

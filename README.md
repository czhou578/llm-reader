# llm-reader

A keyboard-first PDF reader with a built-in LLM tutor. The design is in [DESIGN.md](DESIGN.md).

## Quick start

```bash
pnpm install
pnpm dev        # Vite on http://127.0.0.1:5173, server on 127.0.0.1:7777
pnpm test       # platform smoke tests
pnpm build && pnpm start
```

Copy `config.example.toml` to `~/.config/llm-reader/config.toml` and set the environment variables it names.

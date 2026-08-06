# NOTES — the user's world

## Tools & channels

- **Repo**: `narwhal-data-hub` — spec for a local MCP server: bitemporal, FINOS CDM-structured product data pool (US/HK/SG venues).
- **Issue tracker**: local markdown files under `.scratch/<feature>/` (per CLAUDE.md). Wayfinder maps + tickets live here.
- **Wiki**: llm-wiki hub at `/root/wiki`; active topic `finos-cdm-reference-data` at `/root/wiki/topics/finos-cdm-reference-data`. Session capture layer: `HUB/.sessions/`; feedback candidates: `HUB/.sessions/feedback/`; promotion target: topic `raw/notes/`.
- **Skills**: mattpocock set (`wayfinder`, `grilling`, `research`, `handoff`, `implement`, `tdd`, …) and llm-wiki set (`wiki:query`, `wiki:ingest`, `wiki:lint`, `wiki:session`, `wiki:feedback`, …).

## Canonical terms

- **long-running wayfinder** — one main session that works _many_ map tickets (not the usual one-ticket-per-session), fanning all heavy work to sub-agents so the main context stays lean.
- **the map** — wayfinder's shared map issue on the local-markdown tracker; durable cross-session state.
- **wiki-lint** — `/wiki:lint` health pass over the topic wiki.
- **promote** — explicit copy of session/feedback digest into the topic wiki (`raw/notes/`), per wiki skill rules. Automated capture is allowed; automated promotion is not — so promotion is a deliberate workflow step.

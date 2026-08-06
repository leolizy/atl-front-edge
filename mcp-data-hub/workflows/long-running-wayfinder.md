# Workflow: long-running-wayfinder

One main session works _many_ wayfinder map tickets by fanning heavy work to sub-agents. Follow the `/wayfinder` skill for all map/ticket mechanics — this workflow only specifies what differs from or extends the base skill.

## Trigger

User opens a wayfinder session: `/wayfinder` to chart or work through a map.

## Session lifecycle

- **Start**: pull from main, branch `wayfinder/<map-slug>`. The SessionStart hook injects a rehydrate context block pointing at the last session digest. No handoff doc, no `/compact` — the fresh session IS the compact.
- **Progress**: automatic hooks capture at ~50 tool events. Manual `/wiki:session capture --summary 'Ticket N: <what was resolved>'` at each ticket close.
- **End (budget trip)**: finish the in-flight ticket, run `/wiki:session capture --summary 'Budget tripped — <last-ticket-summary>'`, then proceed to wind-down. Never abandon a ticket mid-resolution.

## Ticket routing

AFK tickets only. HITL tickets (grilling, prototype) sit on the frontier for the human to pick up — this workflow does not process them.

- **Research** → `Agent(wiki-manager)`. Parallel ok.
- **Implementation** → `Agent(ponytail)`. Sequential only — they mutate the repo.

Sub-agents use isolated worktrees. The main session reviews and commits each result. Commit after each sub-agent completes — no ADR prompt, no writing-fragments prompt.

## Budget & cadence

Context occupancy threshold **130k** (of ~200k). Check at ticket boundaries. On crossing: capture → wind-down.

## Wind-down

After session capture. Steps 1, 2, 3 fire parallel; 4 blocks on all.

1. **Lessons learned** → `Agent(wiki-manager, background)`. `/wiki:ll`.
2. **Archive tickets** → `Agent(wiki-manager, background)`. Move resolved ticket files to wiki `inbox/`, `/wiki:ingest --inbox`.
3. **Architecture review** → `Agent(general-purpose, background)`. `/improve-codebase-architecture`.
4. **Push and PR** → after all wind-down agents complete: push the branch, then `gh pr create`. Title: `<map-destination> — <date>`. PR body is the handoff: list of resolved tickets (from the map's Decisions-so-far), open HITL tickets for human follow-up, and a one-line next step. Create a follow-up child ticket on the map for whatever the human needs to do next.

## Fixed locations

- **Map + tickets**: `.scratch/<feature>/`
- **Topic wiki**: `/root/wiki/topics/finos-cdm-reference-data`
- **Session digests**: `/root/wiki/.sessions/`
- **Feedback**: `/root/wiki/.sessions/feedback/`

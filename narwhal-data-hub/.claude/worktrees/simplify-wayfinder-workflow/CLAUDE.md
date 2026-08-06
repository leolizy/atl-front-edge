## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Commit guardrail

**Commit at every stage boundary.** When an agent finishes a ticket (or any discrete unit of work) and is about to move on to the next, it commits first. Each ticket's implementation lands as its own isolated commit. This keeps the history traceable to individual tickets and makes bisecting straightforward.

- Commit message references the ticket number (e.g., `feat: implement pool store schema (ticket 01)`)
- Commit before handing off to another agent or starting the next ticket — never batch unrelated tickets into one commit
- If work spans multiple agents within a single ticket, commit at each handoff point within that ticket

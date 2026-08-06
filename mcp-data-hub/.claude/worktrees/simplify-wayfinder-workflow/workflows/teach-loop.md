# Workflow: teach-loop

A sub-workflow of `long-running-wayfinder`. When the user wants to learn something mid-session, the main session checkpoints, hands off to a teaching agent, and resumes clean when the user returns.

## Trigger

User says any of these in the main session:

- "teach me about X"
- "I want to learn about Y"
- "give me a lesson on Z"

Keyword detection: `teach me`, `learn about`, `lesson on`, `I want to learn`. A quick factual question ("what's a CDM qualifier?") without these keywords is answered inline — not a teach trigger.

## Flow

### 1. Checkpoint

Main session checkpoints current state before handing off:

```
/wiki:session capture --summary "Pausing for teaching: <topic>"
```

This writes a session digest so rehydrate can pick up the thread after teaching.

### 2. Handoff summary

Main session writes `teach-handoff-<slug>.md` to `.scratch/<feature>/`:

```markdown
# Teach: <topic>

**Context**: <what the user was working on when they asked — ticket number, map, why this topic matters now>

**Topic**: <what to teach>

**Mission**: <why the user wants to learn this — infer from context, confirm with user if unclear>

**Teaching workspace**: .scratch/teach-<slug>/

**Use skill**: /teach
```

### 3. Launch teaching agent

Main session runs:

```bash
claude --bg --name "teach-<slug>" "$(cat .scratch/<feature>/teach-handoff-<slug>.md)"
```

The teaching agent:

- Creates teaching workspace at `.scratch/teach-<slug>/`
- Follows `/teach` skill: establish MISSION.md, find resources, create lessons
- Interacts directly with the user (HITL — the user is the learner)

### 4. Teaching session

The user interacts with the teaching agent in a separate Claude session. The agent produces:

- `MISSION.md` — why they're learning
- `lessons/*.html` — self-contained interactive lessons
- `learning-records/*.md` — key insights captured
- `reference/*.html` — cheat sheets, quick-reference
- `RESOURCES.md` — high-quality sources used

### 5. Close out

When the user is done learning (they say "done," "that's enough," "back to work"), the teaching agent writes a summary:

```markdown
# Teach summary: <topic>

**Covered**: <one-line scope of what was taught>

**Lessons created**: <count>, at .scratch/teach-<slug>/lessons/

**Key takeaways**:

- <takeaway 1>
- <takeaway 2>

**Follow-up**: <anything the user should revisit or practice>
```

Save to `.scratch/<feature>/teach-summary-<slug>.md`.

### 6. Resume main session

User returns to the main session and says "done, continue" or similar.

Main session:

1. Reads `.scratch/<feature>/teach-summary-<slug>.md` for context
2. Rehydrates from the pre-teaching checkpoint: `/wiki:session rehydrate --cwd .`
3. Resumes the in-flight ticket

## Teaching workspace

`.scratch/teach-<slug>/` — isolated from the repo, already gitignored (under `.scratch/`). One workspace per topic. Reusable across sessions — if the user asks to learn more about the same topic later, the existing workspace continues to grow.

## Integration with long-running-wayfinder

The teach loop is a HITL fan-off pattern — the user is the other party, so it's never fully automated. When triggered, it takes priority over the current ticket: checkpoint immediately, teach now, resume after.

The main session does NOT:

- Run other tickets while waiting (the user is occupied)
- Treat the teaching session as a ticket (it produces no map artifact)
- Ingest teaching materials into the wiki automatically (the user may promote selectively later)

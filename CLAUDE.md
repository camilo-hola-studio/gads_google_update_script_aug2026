# CLAUDE.md

## Task-observer skill activation

If `~/.claude/skills/task-observer` does not exist, install it first:

```
git clone --depth=1 https://github.com/rebelytics/one-skill-to-rule-them-all ~/.claude/skills/task-observer
```

At the start of any task-oriented session — any interaction where you will
use tools and produce deliverables — invoke the task-observer skill before
beginning work. This ensures skill improvement opportunities are captured
throughout the session.

When loading any skill, check the observation log for OPEN observations
tagged to that skill. Apply their insights to the current work, even if
the skill file hasn't been updated yet. This enables immediate application
of observations before they're permanently integrated during the weekly
review.

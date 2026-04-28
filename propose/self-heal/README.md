# Self-Heal Toolkit — Proposal (NOT YET DEPLOYED)

**Status:** Staged for review. Does NOT run from the agent process.
**Date:** 2026-04-28
**Origin:** Today's read-only-root wedge (free space hit 0% → ext4 remounted ro → cascading ENOENT phantoms in agent session). Took ~30 min of Varun's time to recover manually.

## The Self-Heal Boundary Rule

> **An agent can heal anything except the thing whose restart kills the agent.**
> That last piece must be third-party — cron, watchdog, or human.
> Together they form a self-healing system.

This pattern applies way beyond disk wedges. Anywhere the runtime depends on something the runtime itself manages, you need an third-party watchdog.

## Architecture

Three pieces. Pieces 1 + 2 the agent runs; piece 3 cron runs.

```
┌─────────────────────────────────────────────────────────────────┐
│  Piece 3: External cron watchdog (every 5 min)                  │
│  /etc/cron.d/openclaw-watchdog                                │
│                                                                 │
│  • Detects ro-root → invokes Piece 1                            │
│  • Detects disk >90% → invokes Piece 1 (proactive)              │
│  • If Piece 1 ran in last 10 min → restarts ocplatform.service  │
│    (which the agent CANNOT restart from inside itself)          │
│  • Sends Discord alert if disk >85%                             │
└─────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Piece 1: Disk-heal script (sudoers-whitelisted)                │
│  /usr/local/bin/openclaw-disk-heal.sh                         │
│                                                                 │
│  • df -h /                                                      │
│  • journalctl --vacuum-size=200M                                │
│  • find /var/log -mtime +14 -delete (rotated logs)              │
│  • mount -o remount,rw / (recovery from errors=remount-ro)      │
└─────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Piece 2: Sudoers entry — narrow whitelist                      │
│  /etc/sudoers.d/ocplatform-selfheal                             │
│                                                                 │
│  varunmahna ALL=(root) NOPASSWD: /usr/local/bin/openclaw...   │
│  (script paths only; not raw mount/find/journalctl)             │
└─────────────────────────────────────────────────────────────────┘
```

## Why three pieces?

The agent runs as a non-privileged user inside `openclaw.service`, with kernel `no_new_privileges` flag. It cannot `sudo`. We give it a narrow privilege escalation (sudoers whitelist), but ONLY for our scripts — not raw `mount` / `find` / `journalctl`. That keeps the privilege surface small.

The agent CAN'T do piece 3 (gateway restart) because that kills its own session mid-execution. So a cron-based third-party watchdog handles that.

## Files in this directory

- `ocplatform-disk-heal.sh` — Piece 1 (script)
- `ocplatform-watchdog.sh` — Piece 3 (script that cron invokes)
- `sudoers.d-ocplatform-selfheal` — Piece 2 (sudoers entry text)
- `cron.d-openclaw-watchdog` — cron entry text
- `default-openclaw-watchdog.env` — env file for Discord webhook URL
- `DEPLOY.md` — exact deploy steps for Varun

## Decision deferred

These scripts ARE staged here. They are NOT deployed. Varun reviews → green-lights → runs the deploy steps in DEPLOY.md.

## Non-goal

This is NOT a permanent fix for the underlying issue (kernel keeping stale dentry caches even after disk recovery + remount-rw). That's a Linux quirk and outside our control. This toolkit just ensures we never hit the wedge in the first place.

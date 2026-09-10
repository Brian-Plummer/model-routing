---
description: Live quota, pace, and lane states across Claude A/B and Codex
allowed-tools: Bash
---

Run `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js" status` and present the output as a short
dashboard: one line per lane (utilization, pace sign, reset day, STATE), then the open-contest
count. Flag any lane in SOFT/BURN/CLOSED/STALE state with one sentence on what that means for
routing right now.

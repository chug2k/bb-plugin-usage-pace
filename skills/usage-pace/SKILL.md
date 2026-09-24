---
name: usage-pace
description: Check provider quota and burn-rate pace — whether the current rate lasts until the window resets, when it runs out, and the daily budget that lasts.
---

Run `bb usage-pace` for weekly windows with pace, `bb usage-pace --all --force` for every window from all reporting hosts, and `bb usage-pace --json` for a `pace` object on each window (`ratio`, `projectedPercent`, `runsOutAtMs`, `lockoutMs`, `budgetPerHour`). `bb usage-pace --tokens` gives recorded token totals. Pace is a straight-line projection from the start of the window; it is null for labels with no known length.

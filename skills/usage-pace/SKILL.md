---
name: usage-pace
description: Check provider quota and burn-rate pace — whether the current rate lasts until the window resets, when it runs out, and the daily budget that lasts.
---

Run `bb usage-pace` for weekly windows with pace, `bb usage-pace --all --force` for every window from all reporting hosts, and `bb usage-pace --json` for a `pace` object on each window (`ratio`, `projectedPercent`, `runsOutAtMs`, `lockoutMs`, `budgetPerHour`). `bb usage-pace --tokens` gives recorded token totals. Grok Build shows up as provider `usage-pace-grok`. Pace is a straight-line projection from the start of the window; it is null for labels with no known length.

The Grok CLI access token lasts 6 hours. While `renewGrokSession` is on (the default), the plugin checks each connected machine every 15 minutes and, once that login is 5 hours old, runs `grok models` with a wide early-refresh window. That uses the saved refresh token and writes a new access token. It does not run `grok login` and it does not open a browser. `bb usage-pace renew-grok` checks now. `bb usage-pace renew-grok --force` renews even when the login is younger than 5 hours. Turn the check off with `bb plugin config usage-pace set renewGrokSession false`.

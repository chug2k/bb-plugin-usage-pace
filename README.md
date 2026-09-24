# Usage Pace

[![BB](https://img.shields.io/badge/bb-0.43%2B-blue)](https://getbb.app)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Tells you if the current burn rate lasts until each quota window resets. If the rate does not last, it tells you when the quota runs out and how long you will be without quota.

A fork of [Usage Bar](https://github.com/dmitriikapustin/bb-plugins-by-kapustin/tree/main/plugins/usage-bar) by Dmitrii Kapustin (MIT). The pace calculation and the usage-card integration are new. The optional footer strip, the dialog, the token totals and the CLI come from Usage Bar.

## What it shows

**In bb's usage card** (the built-in Provider usage card in the sidebar footer):

- Each window's bar gets a tick at **even pace**: where the bar would be if you used the quota at an exact even rate. If the fill goes past the tick, you are ahead of pace.
- Hover a row (or focus it with the keyboard) to see the delta under the reset time:

```
7d    [█████████|██········]  44%   5d 2h
               17% ahead of pace (1d 4h)
        runs out Sun 00:03 · 2d 15h without quota
```

The first line is the difference from even pace, in percentage points and in time. The second line is the time without quota before the reset, or the daily budget that lasts.

The card belongs to another plugin. Usage Pace only adds nodes to it. If a bb update changes the card's markup, the tick and the delta stop showing, and nothing else breaks.

**Optional footer strip.** Turn on *Also show the Usage Pace strip* in the plugin settings. It shows one chip for each provider account (the weekly window):

```
✳ 44% 1.6× · 2d 15h short
```

- `44%`: the used percent.
- `1.6×`: the pace. The used percent divided by the share of the window that has passed. `1.0×` is even pace.
- `2d 15h short`: at this rate, the quota runs out 2d 15h before the reset. If the rate lasts, the chip shows the time to the reset.

The colour changes to warning when the projection is above 85%, and to critical when it is above 100%. The Usage Bar thresholds (80% and 95% used) also stay.

**Dialog.** Click the strip to open it. Each window shows a bar with a mark at even pace, the rate details, and the result:

```
Weekly limit                    resets in 5d 2h   44%
[██████████████|·······················]
1.6× pace · on track for 161%           2d 15h without quota
· budget 11%/day                   runs out Sun 27 Sep, 00:03
```

`budget` is the rate per day (or per hour, for windows shorter than two days) that lasts exactly until the reset.

## How pace is calculated

Providers report only `usedPercent` and `resetsAt` for each window. The window length comes from the label: `5h`, `7d`, `Weekly`, `5-hour window`, or `session` (5 hours). A window with no length in its label, for example `Fable`, takes the length of a window that resets at the same time. Then:

- start of window = reset − length
- pace = used ÷ (elapsed ÷ length)
- runs out = now + elapsed × (100 − used) ÷ used, if that is before the reset
- time without quota = reset − runs out

This is a straight-line projection. Nights and weekends usually lower the real rate. In the first 5% of a window, the plugin shows "too early to judge pace" and no projection.

## Install

```sh
bb plugin install 'git:https://github.com/chug2k/bb-plugin-usage-pace.git@^0.1.0'
```

From a local checkout:

```sh
bb plugin install ./
```

If you turn on the strip, do not also install Usage Bar. Both plugins put a strip in the same footer.

## From the terminal

```sh
bb usage-pace              # weekly windows, with pace
bb usage-pace --all        # every window
bb usage-pace --json       # each window has a `pace` object
bb usage-pace --tokens     # token totals across BB
```

```
Claude Code · Max (5x) (MacBook Pro)
  Weekly limit        44%  resets in 5d 2h
                     runs out Sun 00:03, 2d 15h before reset · 1.6× pace · on track for 161% · budget 11%/day
```

## Requirements

bb **0.43+** and Plugin SDK **0.5.9+**. The plugin uses the provider authentication that bb already has. Only providers and hosts that report quota information appear. Token totals are not billing data.

## Development

```sh
npm install
npm run check   # tsc
npm test        # vitest (pace) + node:test (token totals)
npm run build   # bb plugin build
bb plugin reload usage-pace
```

---

[MIT](LICENSE) · Charles Lee · based on Usage Bar by Dmitrii Kapustin

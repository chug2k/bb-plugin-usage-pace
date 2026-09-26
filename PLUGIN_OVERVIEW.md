bb's usage card shows how much of each quota window you used, and when it
resets. It does not show if your rate lasts until then. With 42% used and five
days to go, are you fine or not? Usage Pace answers that in the same card.

## What you get

- **A tick at even pace.** Each bar gets a tick where the bar would be if you
  used the quota at an exact even rate over the window.
- **The difference in colour.** The part of the bar past the tick is red: that
  is how far ahead of pace you are. When you are under pace, the free part up
  to the tick is light grey.
- **The numbers on hover.** Hover a row to see two lines under the dates, for
  example "17% ahead of pace (1d 5h)" and "runs out Sat 23:05 · 2d 16h
  without quota". When the rate lasts, the second line shows the daily budget
  that lasts to the reset.
- **The same on a touch screen.** Tap a row to show the lines. Tap again to
  hide them.
- **`bb usage-pace`** prints each window with its pace in a terminal, and
  `--json` gives agents a `pace` object for each window.

## How pace is calculated

Providers report the used percent and the reset time of each window. The
window length comes from its label ("Five-hour limit", "Weekly limit"). A
window without a length in its label takes the length of a window that resets
at the same time. The start of the window is the reset time minus the length.
The plugin then projects the current rate in a straight line to the reset.

Nights and weekends usually lower the real rate, so the projection is a
warning, not a forecast. In the first 5% of a window, the plugin shows "too
early to judge pace".

## Requirements and data

The plugin reads the data that bb's built-in Provider usage card already has,
from that card's cache, so it adds no provider requests. It needs no
credentials or external service. It only adds elements to bb's card. If a bb
update changes the card, the tick and the lines stop showing, and nothing else
breaks.

Usage Pace is a fork of Usage Bar by Dmitrii Kapustin (MIT). The optional
Usage Bar footer strip is still in the plugin, off by default.

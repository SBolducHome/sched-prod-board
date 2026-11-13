# sched-prod incident board — plan

The on-call board for sched-prod. One page, one list: tonight's incidents, newest first, so on-call sees
what just broke and takes it.

## Flows

| flow | who | what happens |
|------|-----|--------------|
| `open-board` | on-call | opens the board; sees tonight's incidents |
| `ack-incident` | on-call | picks an incident on the board and acks it — "I've got this one" |
| `watch-board` | on-call | keeps the board open; the list holds still, a "N new" bar shows what came in, one click brings it in |

## Requirements

- **R1** The list holds still while it is on screen; a "N new" bar brings new incidents in on click, at the
  top, newest first. New incidents never move the rows, the bar or anything above the list. When nothing is
  on screen (the empty state), new incidents show directly.
- **R2** Each incident row has an **Ack** button. Ack sends the ack (`api.ack(id)`) and marks the row acked.
  Ack stays on the row.
- **R3** Show a loader until incidents load.
- **R4** The board refreshes itself every 2 seconds while open: it starts a request every 2 seconds and keeps
  the latest answer for the bar (R1).
- **R5** Times show in the viewer's local time; day before month for EU locales (dd/mm).
- **R6** The page names its build: `<meta name="build" content="<git sha>">` in the head and the same sha in the footer.

## Hooks (pinned — tests and the replay rely on them)

| `data-testid` | element |
|---------------|---------|
| `board` | the board's main area |
| `loader` | the loader (gone once incidents load) |
| `empty` | what shows when there are no incidents |
| `incident-list` | the list |
| `incident-row` | one incident row, with `data-id="<incident id>"` |
| `ack` | the Ack button in a row |
| `acked` | the acked mark in a row |
| `new-bar` | the "N new" bar (visible only when new incidents wait; a click brings them in) |
| `build-sha` | the sha in the footer |

## Decisions

- 2026-11-12, product, on the step-1 recording (rows moved under the pointer as new incidents came in):
  "The list holds still while it is on screen; a "N new" bar brings new incidents in on click. Ack stays on
  the row." Changed R1, R2, R4 and `watch-board`; added `new-bar`; SCHED-4515.

## Done

Every issue in `issues/` delivered, deployed to a public https address, and shown working.

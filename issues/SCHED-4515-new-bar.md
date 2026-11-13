---
id: SCHED-4515
title: The list holds still; a "N new" bar brings new incidents in
status: ready
plan: R1, R2, R4
---

Follow-up to SCHED-4511. New incidents land at the top every few seconds and push every row down, so an
Ack aimed at one row can land on the next. Product: "The list holds still while it is on screen; a "N new"
bar brings new incidents in on click. Ack stays on the row."

- First answer: the list as today (loader, then rows or `empty`). While nothing is on screen (empty state),
  new incidents show directly.
- Once rows are on screen, later answers do not insert, remove, reorder or re-render rows; the board keeps
  the latest answer aside (R4 still starts a request every 2 seconds).
- When the latest answer has incidents not on screen, show the bar (`data-testid="new-bar"`, a button):
  "1 new incident · show" / "3 new incidents · show". Its slot between the header and the list is always
  there, so the bar appearing moves nothing; when nothing is new it is hidden (not `:visible`).
- Clicking the bar applies the latest answer: new rows at the top, rows the API dropped removed (except a
  row whose Ack is in flight), bar hidden, acked marks kept.
- Ack stays on its row (R2).
- The "could not refresh" note moves nothing either (it lives in the bar's slot).
- The bar is reachable by keyboard; the count is announced politely (`aria-live`) without moving focus.

Acceptance:
- While new incidents arrive, the top row, every row's position and the rows in the DOM stay the same.
- The bar shows the right count, appears without moving any row, and a click brings the new incidents in at
  the top within 600 ms; the top row then has an Ack button.
- An Ack aimed at a row while a new incident arrives mid-aim acks that row's incident.
- An empty API still shows `empty`; the "could not refresh" note moves no row.

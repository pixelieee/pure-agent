# Minimal terminal presentation

This presentation slice uses the existing Pi components without importing
compaction, checkpoint, provider-error or shutdown APIs.

## Presentation

- One `pure agent` title, workspace and provider/mode identity stay above the transcript.
- Ordinary text uses the terminal's foreground and background. Blue `#657da5` and
  purple `#88749f` are limited to accents. Selected commands and user bands always
  set both foreground and background; `NO_COLOR` and `TERM=dumb` disable styling.
- Assistant Markdown has no repeated role heading. A single `›` and a subdued
  user band distinguish user input. Errors retain a textual `!` marker.
- The Pi editor keeps its editing, cursor and overflow behavior. Its lower border
  is blank unless hidden lines need an indicator. Shortcut hints select a complete
  variant that fits the current width rather than truncating a command midway.
- Tool summaries reserve space for the state. Restored entries say `recorded`;
  long paths cannot push the state off the line. Ctrl+O still toggles details.
- Redirected/plain output retains its existing role labels for log readability.

No execution, model, authorization, persistence or controller behavior is changed.

## Verification and limits

The dedicated `node --test test/ui-presentation.test.ts` suite exercises the real
Pi editor/rendering layer without constructing an agent, model adapter or model
response. It covers widths 12–100, Unicode draft editing, resizing, command menu
opening/dismissal, a real source-file read shown as recorded tool evidence, user
and error markers, plain output and color opt-out.

This local candidate recovers the presentation from `e487740` on the explicit
credentials base `9317005`. Historical mixed model tests and their assertions are
unchanged and unrun. The separate session-operation slice is documented in
[ui-operation-status.md](ui-operation-status.md). Command-output preview changes
from `2fe8002` are deliberately excluded.

Earlier reviewed visuals were rasterized component output, not physical-terminal
screenshots or live-model evidence. Live API, physical terminal, Windows/macOS
and remote CI acceptance are not established by this candidate.

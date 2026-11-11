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

### Output navigation (functional candidate)

Command cards place readable combined stdout/stderr before arguments and raw JSON.
Ctrl+O still toggles details globally; no per-card focus mode is introduced.
Pi 1.5.0 owns PgUp/PgDn, Ctrl+Home and Ctrl+End. While away from the bottom,
its native indicator offers Ctrl+End; transcript changes switch the label to
“New output”. Returning to the bottom clears that notice. Narrow terminals
shorten the label without adding a new shortcut. Mouse capture remains disabled.

The transcript preserves the top visible component and its bounded rendered-line
offset across append, details toggles and width changes. If a component shrinks,
the offset clamps to its last line; terminal height and available scroll range
can also clamp the viewport. This is block anchoring, not character-level reflow
anchoring inside a long paragraph. The editor remains focused and drafts stay
unchanged. Session reset clears anchors and unread state.

These changes are behavior-only and do not establish a final visual design.

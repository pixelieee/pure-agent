# Minimal terminal presentation

This presentation slice uses the existing Pi components without importing
compaction, checkpoint, provider-error or shutdown APIs.

## Presentation

- One `pure agent` title, workspace and provider/mode identity stay above the transcript.
- Ordinary text uses the terminal's foreground and background. A single sage
  `#a6b39b` marks input; ANSI dim separates metadata. Selection uses terminal
  inverse colors and user prompts are unboxed; `NO_COLOR` and `TERM=dumb` disable styling.
- Assistant Markdown has no repeated role heading. A single `›` and a bold
  unboxed prompt distinguish user input. Errors retain a textual `!` marker.
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
response. It covers widths 3–100, Unicode draft editing, resizing, command menu
opening/dismissal, a real source-file read shown as recorded tool evidence, user
and error markers, plain output and color opt-out.

This publication stack starts from the interactive command cards in #41 (local
`0eea924`, tree `def7b6136529cc23d355e0ec665c9b9116e674aa`) and adds the separate
output-navigation slice `9107857`. It does not import unrelated core integration
changes. Historical mixed model tests and their assertions are unchanged and
unrun. Session-operation behavior is documented in
[ui-operation-status.md](ui-operation-status.md).

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

## Refined presentation (2026-11-11)

The presentation source was developed as `5a2d8fc` on the full integration, then
isolated above the #41-based output-navigation slice for publication. It replaces
blue/purple bands with terminal-native foreground, restrained sage input accents
and dim secondary text. Prompt, tool and output spacing are aligned without
adding cards, role headings or decorative chrome.

- Shell commands wrap to two lines when collapsed, with an explicit notice if
  more lines are hidden. Expanded details retain the complete command.
- Successful command previews prefer the last eight rendered lines. Failed
  commands keep the first ten and last three, with a middle clipping notice when
  needed. The character bound also preserves the true tail for failed commands;
  source results are not changed.
- Tool truncation, omitted retained bytes and continuation cursors remain visible.
  Combined-stream attribution and log completeness share one subdued bottom line;
  full log paths remain in expanded details. An exited command's exit code appears
  once in its title, while failed/terminated status remains explicit.
- Scrollbar tracks are blank, leaving only Pi's dim position thumb. Navigation,
  draft handling, block anchors and the return-to-bottom control are unchanged.

Final isolated-stack checks: static quality/type/build passed; 73 fixed-list
non-model checks and one installed-package check passed, including 16 presentation
checks. A real subprocess verifies both ends of a long failed command's output
and disclosure at widths 24, 54 and 100. Identified transcript blocks verify
navigation across reflow, and widths 3–4 retain Pi's original text/cursor bytes.
No simulated model tests were run.

Eight fresh Pi screen-line captures were rasterized and visually inspected,
including prompt, actual read, running command, completed command, expanded data,
narrow layout, a real failed command and the slash-command menu. Independent
visual review accepted the original capture set; this is not user design approval.
These are real component/local-tool render captures, not a physical terminal or
live model acceptance claim. Font/background choices in the captures belong to
the rasterizer; terminal-specific contrast and assistive-technology behavior need
separate acceptance.

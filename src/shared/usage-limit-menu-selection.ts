export type UsageLimitMenuOption = {
  label: string
  selected: boolean
}

/** What the tail says about the chooser — three answers, not two. `unreadable`
 *  is the one that earns its keep: a screen we cannot classify must stop the
 *  watcher from pressing keys AND stop a scheduled message from being typed, and
 *  one boolean can only ever make one of those two the safe default. */
export type UsageLimitMenuReading =
  | { state: 'live'; options: UsageLimitMenuOption[] }
  | { state: 'dismissed' }
  | { state: 'unreadable' }

/** The one wording that identifies the free option. Shared with the stall
 *  detector so the text that *finds* the menu and the text that *picks a row in
 *  it* can never drift: if only one were updated after a CLI reword, detection
 *  would keep firing and selection would refuse every time. */
export const USAGE_LIMIT_RESET_LABEL_SOURCE = String.raw`stop\s*and\s*wait\s*for\s*(?:the\s*)?limit\s*to\s*reset`

const CURSOR_RE = /^\s*[❯>▶]\s*/
const NUMBERED_RE = /^\s*(?:[❯>▶]\s*)?(\d{1,2})[.)]\s+(.*)$/
const RESET_LABEL_RE = new RegExp(USAGE_LIMIT_RESET_LABEL_SOURCE, 'i')
const PAID_LABEL_RE =
  /extra\s*usage|usage\s*credits|add\s*funds|upgrade\s*your\s*plan|request\s*more/i

/** The chooser's own footer. Wording-tolerant like the reset label: the PTY
 *  sometimes drops the spaces between words. */
const CHOOSER_HINT_RE = /enter\s*to\s*confirm|esc\s*to\s*cancel/i
/** Horizontal rules the CLI draws around its dynamic region, label or not
 *  ("─────────── portal fixes ──"). Starts with the rule glyph, so the prompt
 *  box's corner rows (╭ │ ╰) never match. */
const HORIZONTAL_RULE_RE = /^[─━═]{3,}/
/** The CLI's persistent bottom rows: mode/effort indicators and the shortcuts
 *  hint. The user's statusline renders beneath them, so once one is seen the
 *  rest of the tail is that statusline. */
const BOTTOM_CHROME_RE = /shift\s*\+\s*tab|\/effort\b|\?\s*for\s*shortcuts/i
/** The CLI's own notice rows (auth, connector and transcript warnings). Chrome,
 *  and in captured frames they render ABOVE the mode row — so they must be
 *  recognised in their own right rather than ride on having seen one. */
const CLI_NOTICE_RE = /^⚠\s/
/** Positive proof the CLI moved on: it only offers an input row — boxed, or the
 *  bare `❯ ` placeholder between rules — while it is accepting typing, and
 *  transcript bullets only appear once a turn is running. A `❯` here is never a
 *  chooser cursor: numbered rows are consumed as options before this sees them.
 *  This is the only evidence strong enough to call a screen free; absence of it
 *  is not. */
const MOVED_ON_RE = /^[╭╰]─|^│\s*>|^[⏺⎿]\s|^❯\s/
/** How much unrecognised text may still be a statusline when the CLI painted no
 *  persistent bottom rows to anchor it (default permission mode paints none).
 *  Below those rows a statusline is unbounded and accepted on position alone;
 *  above them it has to stay small, or resumed output would hide in it. */
const MAX_UNANCHORED_STATUSLINE_LINES = 2

/** Read the non-blank lines under a chooser, top-down.
 *
 *  While the chooser is live only its own chrome can sit there: the confirm
 *  hint, a rule, the mode/effort rows, and the user's statusline beneath those.
 *  `moved-on` is text that proves the CLI repainted; `unrecognised` is text that
 *  is merely not chrome, which is a different answer — it might be agent output
 *  under a dead chooser or a statusline we do not know, and the caller has to
 *  treat it as neither live nor free.
 *
 *  Why classify content rather than count lines (the rule before this one): a
 *  live chooser can carry seven chrome lines (2026-08-27 field failure, four-line
 *  budget) while five lines of agent output already mean the agent moved on, so
 *  no budget separates the two. Usually there is nothing to classify at all: the
 *  CLI parks the cursor on the highlighted row and the tail drops every row below
 *  it, in live bytes and in the restore snapshot alike (SerializeAddon restores
 *  the cursor with a relative cursor-up). */
function readBelowChooser(linesBelow: string[]): 'chrome' | 'moved-on' | 'unrecognised' {
  let sawChooserChrome = false
  let sawBottomRow = false
  let unanchored = 0
  for (const line of linesBelow) {
    // Checked on every line, never short-circuited: the statusline region below
    // is the one place unrecognised text is tolerated, and it is also where a
    // repainted prompt box would sit.
    if (MOVED_ON_RE.test(line)) {
      return 'moved-on'
    }
    if (BOTTOM_CHROME_RE.test(line)) {
      sawBottomRow = true
      continue
    }
    if (CHOOSER_HINT_RE.test(line) || HORIZONTAL_RULE_RE.test(line) || CLI_NOTICE_RE.test(line)) {
      sawChooserChrome = true
      continue
    }
    if (sawBottomRow) {
      continue
    }
    unanchored += 1
    if (!sawChooserChrome || unanchored > MAX_UNANCHORED_STATUSLINE_LINES) {
      return 'unrecognised'
    }
  }
  return 'chrome'
}

/** The chooser's heading. It cannot prove a chooser — any agent that prints this
 *  line above a numbered row forges it, and `cat`-ing this repository's own
 *  design notes does exactly that. What it buys is that a bare row is no longer
 *  enough, so the accidents (a grep hit, a log line, a Markdown quote of one
 *  option) stop arming the watcher. The rule the CLI draws above the heading is
 *  deliberately not a second anchor: it sits further from the options, so it
 *  never decides a real chooser, while a Markdown divider forges it. */
const CHOOSER_HEADING_RE = /what\s*do\s*you\s*want\s*to\s*do/i
/** How many non-blank lines above the run may be searched (blank padding is
 *  skipped, not counted). The captured frame puts the heading one non-blank line
 *  up; the budget is larger because a banner can sit between. */
const MAX_LINES_ABOVE_CHOOSER = 4

/** Whether the CLI's chooser heading sits just above the numbered run. */
function hasChooserHeadingAbove(lines: string[], startIndex: number): boolean {
  return lines
    .slice(0, startIndex + 1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-MAX_LINES_ABOVE_CHOOSER)
    .some((line) => CHOOSER_HEADING_RE.test(line))
}

export type UsageLimitMenuReadOptions = {
  /** Accept the highlighted row as the whole chooser even without the heading
   *  above it. Only for a read-back moments after this code pressed arrows into a
   *  chooser it had just read as live: that sequence is the liveness evidence, and
   *  the repaint parks the cursor on the newly highlighted row, which can leave it
   *  as the only row the tail still holds. Never set it for a first reading. */
  trustSingleRow?: boolean
}

/** Read the trailing usage-limit chooser out of a terminal tail. Only the last
 *  contiguous run of numbered options counts, and only while it still sits at
 *  the bottom of the tail, so a menu that scrolled into history — dismissed, or
 *  overtaken by resumed agent output — cannot be mistaken for the live one. */
export function readUsageLimitMenu(
  tailText: string,
  { trustSingleRow = false }: UsageLimitMenuReadOptions = {}
): UsageLimitMenuReading {
  const lines = tailText.split('\n')
  const collected: { number: number; option: UsageLimitMenuOption }[] = []
  const below: string[] = []
  let aboveIndex = -1

  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index] ?? ''
    const match = NUMBERED_RE.exec(line)
    if (!match) {
      if (collected.length > 0) {
        aboveIndex = index
        break
      }
      const trimmed = line.trim()
      if (trimmed.length > 0) {
        below.push(trimmed)
      }
      continue
    }
    const label = (match[2] ?? '').trim()
    if (label.length === 0) {
      continue
    }
    collected.push({
      number: Number(match[1]),
      option: { label, selected: CURSOR_RE.test(line) }
    })
  }

  // Not even a numbered run in the retained tail: no chooser to be parked at.
  if (collected.length === 0) {
    return { state: 'dismissed' }
  }
  const belowState = readBelowChooser(below.toReversed())
  if (belowState !== 'chrome') {
    return belowState === 'moved-on' ? { state: 'dismissed' } : { state: 'unreadable' }
  }
  const ordered = collected.toReversed()
  if (!ordered.every((entry, index) => entry.number === index + 1)) {
    return { state: 'unreadable' }
  }
  const options = ordered.map((entry) => entry.option)
  // Exactly one highlight is what makes a chooser actionable, and it is also why
  // one row can be the whole readable chooser: the retained tail mirrors the
  // screen, and the runtime drops every row below the cursor on cursor-up (it
  // stands in for the erase-to-end-of-screen the normalizer filters out). Ink
  // parks the cursor on the highlighted row after painting, so a chooser whose
  // FIRST option is highlighted — the shape Claude Code shows on subscription
  // billing, where "Stop and wait for limit to reset" is row 1 — arrives here as
  // exactly one option. Demanding two read every such screen as "not a menu" and
  // the watcher dropped it silently (2026-08-27 field failure, third in a row).
  // One row is only ever enough when it is the highlighted one: the plan is then
  // zero arrows, and Enter confirms exactly the row that was read and
  // label-checked. Rows hidden below the cursor cannot be arrowed to blindly —
  // when the reset row is not the visible one, findResetOptionIndex still
  // refuses.
  if (options.filter((option) => option.selected).length !== 1) {
    return { state: 'unreadable' }
  }
  // A run of several rows is self-evidencing: 1..n contiguous, exactly one of
  // them highlighted, nothing but chrome below. A single row is not — one line
  // of ordinary output can satisfy all of that — so it has to be sitting under
  // the CLI's own heading. Unreadable rather than dismissed: the row may well be
  // a real chooser whose heading scrolled out, and neither pressing Enter nor
  // typing a scheduled message into it is safe.
  if (options.length === 1 && !trustSingleRow && !hasChooserHeadingAbove(lines, aboveIndex)) {
    return { state: 'unreadable' }
  }
  return { state: 'live', options }
}

/** The chooser's options when it is live, else null. */
export function parseUsageLimitMenu(
  tailText: string,
  options?: UsageLimitMenuReadOptions
): UsageLimitMenuOption[] | null {
  const reading = readUsageLimitMenu(tailText, options)
  return reading.state === 'live' ? reading.options : null
}

/** Index of the wait-for-reset option, or null when it is absent, ambiguous, or
 *  its label also reads as a paid one. Anything but a single clean match is a
 *  refusal: picking the wrong row here spends the user's money. */
function findResetOptionIndex(options: UsageLimitMenuOption[]): number | null {
  const matches = options
    .map((option, index) => ({ option, index }))
    .filter((entry) => RESET_LABEL_RE.test(entry.option.label))
  const only = matches.length === 1 ? matches[0] : undefined
  if (!only || PAID_LABEL_RE.test(only.option.label)) {
    return null
  }
  return only.index
}

/** Signed arrow presses from the highlighted row to the reset row — positive for
 *  down, negative for up — or null when the menu cannot be read confidently. */
export function planUsageLimitResetSelection(tailText: string): number | null {
  const options = parseUsageLimitMenu(tailText)
  if (!options) {
    return null
  }
  const target = findResetOptionIndex(options)
  if (target === null) {
    return null
  }
  // A live reading has exactly one highlighted row by construction.
  return target - options.findIndex((option) => option.selected)
}

/** Whether the tail ends in a chooser that can actually be interacted with. This
 *  is the test for "an agent is parked at this menu right now" — used to arm the
 *  watcher from restored screen content and before any key is pressed. */
export function isLiveUsageLimitMenu(tailText: string): boolean {
  return readUsageLimitMenu(tailText).state === 'live'
}

/** Whether the tail *proves* no chooser owns the screen. Deliberately not the
 *  negation of `isLiveUsageLimitMenu`: a screen we cannot read is neither, and
 *  the difference is what keeps a scheduled message out of a live chooser, where
 *  its trailing Enter would confirm whichever row the CLI has highlighted. */
export function isUsageLimitMenuDismissed(tailText: string): boolean {
  return readUsageLimitMenu(tailText).state === 'dismissed'
}

/** Whether the cursor currently rests on the reset option. Read back after the
 *  arrows land, so Enter is only ever pressed against a confirmed highlight.
 *  This read alone never arms anything: it follows arrows pressed into a chooser
 *  already read as live, so a lone highlighted row is trusted here — the arrows
 *  themselves are what truncated the menu down to it. */
export function isResetOptionSelected(tailText: string): boolean {
  const options = parseUsageLimitMenu(tailText, { trustSingleRow: true })
  if (!options) {
    return false
  }
  const target = findResetOptionIndex(options)
  return target !== null && options[target]?.selected === true
}

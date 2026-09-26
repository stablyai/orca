import { describe, expect, it } from 'vitest'
import {
  isLiveUsageLimitMenu,
  isResetOptionSelected,
  isUsageLimitMenuDismissed,
  parseUsageLimitMenu,
  planUsageLimitResetSelection,
  readUsageLimitMenu
} from './usage-limit-menu-selection'

const RESET_FIRST = [
  'Claude usage limit reached.',
  '',
  '❯ 1. Stop and wait for the limit to reset',
  '  2. Add funds to continue with usage credits',
  '  3. Upgrade your plan'
].join('\n')

const RESET_LAST = [
  'Claude usage limit reached.',
  '',
  '❯ 1. Add funds to continue with usage credits',
  '  2. Upgrade your plan',
  '  3. Stop and wait for the limit to reset'
].join('\n')

describe('parseUsageLimitMenu', () => {
  it('reads labels and the highlighted row', () => {
    expect(parseUsageLimitMenu(RESET_FIRST)).toEqual([
      { label: 'Stop and wait for the limit to reset', selected: true },
      { label: 'Add funds to continue with usage credits', selected: false },
      { label: 'Upgrade your plan', selected: false }
    ])
  })

  it('takes only the last run, so a scrolled-back menu cannot be read', () => {
    const options = parseUsageLimitMenu(`${RESET_FIRST}\n\nsome output\n\n${RESET_LAST}`)
    expect(options?.[0]?.label).toBe('Add funds to continue with usage credits')
  })

  it('refuses a run whose numbering is not 1..n', () => {
    expect(
      parseUsageLimitMenu('❯ 2. Stop and wait for the limit to reset\n  3. Upgrade')
    ).toBeNull()
  })

  it('refuses anything that is not a menu', () => {
    expect(parseUsageLimitMenu('just some agent output')).toBeNull()
  })

  it('tolerates a hint line and blank padding under a live menu', () => {
    const tail = `${RESET_FIRST}\nEnter to confirm · Esc to cancel\n\n\n`
    expect(parseUsageLimitMenu(tail)).toHaveLength(3)
  })

  it('tolerates the CLI chrome and a user statusline under a live menu', () => {
    // The 2026-08-27 field failure: a parked chooser always carries the hint,
    // the auto-mode/effort rows, and the user's statusline below its options.
    // Seven chrome lines made every real chooser read as scrollback.
    const tail = [
      RESET_FIRST,
      'Enter to confirm · Esc to cancel',
      '⏵⏵ auto mode on (shift+tab to cycle)',
      '● high · /effort',
      '✱ Fable 5  ⚡ high  ◔ 0 (0%) / ~800.0K  # ab9c396c',
      '◱ $0.00 (0) | $0.00/h / 0 tok/h  ⏱ 12s (API: 0s)  📁 browser',
      '5h (14%) 18:50 | 7d (31%) Wed 12:00 | Fable 7d (23%)'
    ].join('\n')
    expect(parseUsageLimitMenu(tail)).toHaveLength(3)
    expect(isLiveUsageLimitMenu(tail)).toBe(true)
    expect(planUsageLimitResetSelection(tail)).toBe(0)
  })

  it('reads a chooser the retained tail truncated at the highlighted first row', () => {
    // The 2026-08-28 field failure, captured verbatim from a pane parked for
    // three hours. Claude Code paints the frame and then parks the cursor on the
    // highlighted row (ESC[5A); the runtime's tail drops every row below the
    // cursor, so options 2..n and the confirm hint never reach this parser. The
    // two-option minimum then read the screen as "not a menu" and the watcher
    // dropped it silently — for the third time.
    const tail = [
      '❯ /rate-limit-options',
      '',
      '─────────────────────────────',
      '  What do you want to do?',
      '',
      '  ❯ 1. Stop and wait for limit to reset',
      ''
    ].join('\n')
    expect(parseUsageLimitMenu(tail)).toEqual([
      { label: 'Stop and wait for limit to reset', selected: true }
    ])
    expect(isLiveUsageLimitMenu(tail)).toBe(true)
    // Zero arrows: Enter confirms exactly the row that was read and label-checked.
    expect(planUsageLimitResetSelection(tail)).toBe(0)
    expect(isResetOptionSelected(tail)).toBe(true)
  })

  it('refuses a lone row that is not inside the CLI chooser frame', () => {
    // A single numbered row satisfies every other liveness test on its own, so
    // any output ending in one used to read as live and plan zero arrows — Enter
    // into whatever the pane was really showing. Both of these are text an agent
    // prints while working: a Markdown quote, and a `cat` of the very notes that
    // document the chooser.
    const quoted = "$ sed -n '10p' notes/auto-resume.md\n> 1. Stop and wait for limit to reset\n"
    const echoed =
      'The retained tail then holds one row:\n  ❯ 1. Stop and wait for limit to reset\n'
    for (const tail of [quoted, echoed]) {
      expect(readUsageLimitMenu(tail).state).toBe('unreadable')
      expect(isLiveUsageLimitMenu(tail)).toBe(false)
      expect(planUsageLimitResetSelection(tail)).toBeNull()
    }
  })

  it('reads a lone row under the heading alone, without the rule above it', () => {
    const tail = '  What do you want to do?\n\n  ❯ 1. Stop and wait for limit to reset\n'
    expect(isLiveUsageLimitMenu(tail)).toBe(true)
    expect(planUsageLimitResetSelection(tail)).toBe(0)
  })

  it('refuses a lone row that opens the tail, with nothing above it to read', () => {
    expect(readUsageLimitMenu('❯ 1. Stop and wait for limit to reset').state).toBe('unreadable')
  })

  it('searches a few lines above the run for the heading, but not the whole tail', () => {
    const row = '  ❯ 1. Stop and wait for limit to reset'
    const between = (count: number): string =>
      ['  What do you want to do?', ...Array.from({ length: count }, () => 'notice'), '', row].join(
        '\n'
      )
    // Blank padding is skipped; only non-blank lines spend the budget, and a
    // banner between the heading and the options is why there is one at all.
    expect(isLiveUsageLimitMenu(between(3))).toBe(true)
    expect(readUsageLimitMenu(between(4)).state).toBe('unreadable')
  })

  it('refuses a lone option that is not the highlighted row', () => {
    // Without a highlight there is nothing to confirm, and the rows the tail
    // dropped could put anything under the cursor — including a paid one.
    expect(parseUsageLimitMenu('  1. Stop and wait for limit to reset\n')).toBeNull()
  })

  it('refuses a lone highlighted option that is not row 1', () => {
    // A tail cut at row 2 hides row 1, so the run is not a readable 1..n menu.
    expect(parseUsageLimitMenu('  ❯ 2. Stop and wait for limit to reset\n')).toBeNull()
  })

  it('refuses a menu buried under resumed agent output', () => {
    const output = Array.from({ length: 9 }, (_, index) => `agent output line ${index + 1}`)
    expect(parseUsageLimitMenu([RESET_FIRST, ...output].join('\n'))).toBeNull()
  })

  it('refuses ordinary agent output under a chooser however short it is', () => {
    // Five lines fit under any budget sized for the seven-line chrome above,
    // so a line count cannot tell them apart; what the lines ARE can.
    const tail = [RESET_FIRST, 'resumed', 'reading', 'editing', 'testing', 'done'].join('\n')
    expect(parseUsageLimitMenu(tail)).toBeNull()
    expect(isLiveUsageLimitMenu(tail)).toBe(false)
    expect(planUsageLimitResetSelection(tail)).toBeNull()
  })

  it('refuses a dismissed chooser with the idle prompt box painted under it', () => {
    // The realistic ghost: Esc on the chooser leaves its text and footer in
    // scrollback, and the CLI paints its prompt box and bottom rows beneath —
    // eight lines, which the old budget accepted, so Enter would have gone
    // into the prompt.
    const tail = [
      RESET_FIRST,
      'Enter to confirm · Esc to cancel',
      '─────────────────────────────',
      '╭─────────────────────────────╮',
      '│ >                           │',
      '╰─────────────────────────────╯',
      '⏵⏵ auto mode on (shift+tab to cycle)',
      '5h (14%) 18:50 | 7d (31%) Wed 12:00 | Fable 7d (23%)'
    ].join('\n')
    expect(isLiveUsageLimitMenu(tail)).toBe(false)
  })

  it('refuses a dismissed chooser with the resumed transcript under it', () => {
    const tail = [
      RESET_FIRST,
      'Enter to confirm · Esc to cancel',
      '⏺ Read(src/main/index.ts)',
      '⎿  Read 120 lines',
      '✻ Thinking… (esc to interrupt)'
    ].join('\n')
    expect(isLiveUsageLimitMenu(tail)).toBe(false)
  })

  it('reads a chooser as live under bottom chrome taller than any line budget', () => {
    // The statusline is user-configured and unbounded; it renders beneath the
    // mode/effort rows, so everything below those rows is the statusline.
    const statusline = Array.from({ length: 6 }, (_, index) => `status row ${index + 1}`)
    const tail = [
      RESET_FIRST,
      'Enter to confirm · Esc to cancel',
      '⏵⏵ accept edits on (shift+tab to cycle)',
      '● high · /effort',
      ...statusline
    ].join('\n')
    expect(isLiveUsageLimitMenu(tail)).toBe(true)
    expect(planUsageLimitResetSelection(tail)).toBe(0)
  })

  it('reads a chooser as live under its footer and the labelled bottom rule', () => {
    // The 2026-08-28 frame's own rows, spaces collapsed the way the PTY
    // sometimes renders them.
    const tail = [RESET_FIRST, 'Entertoconfirm·Esctocancel', '─────────── portal fixes ──'].join(
      '\n'
    )
    expect(isLiveUsageLimitMenu(tail)).toBe(true)
  })
})

// Claude Code's real bottom rows, ANSI stripped, in the order the captured
// frame in claude-terminal-session-options.test.ts paints them: the notice rows
// come ABOVE the mode row, so a rule that only starts trusting the tail once it
// has seen `shift+tab` gives up before it ever gets there.
const CAPTURED_BOTTOM_CHROME = [
  '⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set and …',
  '⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_COD…',
  '🤖 Fable 5 | 📁 tmp | ⚡️ 11.9% · 23.8k tokens',
  '⏵⏵ bypass permissions on (shift+tab to cycle)'
]

describe('readUsageLimitMenu', () => {
  it('reads a chooser as live under notice rows that precede the mode row', () => {
    const tail = [RESET_FIRST, ...CAPTURED_BOTTOM_CHROME].join('\n')
    expect(readUsageLimitMenu(tail).state).toBe('live')
    expect(planUsageLimitResetSelection(tail)).toBe(0)
  })

  it('calls the screen dismissed once the CLI paints its bare input row', () => {
    // The same capture's rule-fenced `❯ ` placeholder. An input row means the CLI
    // is taking typing, so the chooser above it is scrollback — and this is the
    // one shape where a scheduled message may still be delivered.
    const tail = [
      RESET_FIRST,
      '⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set …',
      '────────────────────────────────────────────',
      '❯ Try "fix typecheck errors"',
      ...CAPTURED_BOTTOM_CHROME
    ].join('\n')
    expect(readUsageLimitMenu(tail).state).toBe('dismissed')
    expect(isUsageLimitMenuDismissed(tail)).toBe(true)
  })

  it('reads a chooser under an unfamiliar statusline as unreadable, not dismissed', () => {
    // Default permission mode paints no mode row, so nothing anchors the user's
    // statusline and its wording is theirs, not the CLI's. Neither answer is safe
    // to guess — the watcher must not press keys and a message must not be typed
    // — which is the whole reason for a third state.
    const tail = [
      RESET_FIRST,
      'Enter to confirm · Esc to cancel',
      'batt 87% | cpu 12% | mem 4.1G',
      'ctx 31% | $0.42 | main ↑2',
      'suite: 1311 passing'
    ].join('\n')
    expect(readUsageLimitMenu(tail).state).toBe('unreadable')
    expect(isLiveUsageLimitMenu(tail)).toBe(false)
    expect(isUsageLimitMenuDismissed(tail)).toBe(false)
  })

  it('reads a short statusline under the chooser footer as live', () => {
    // The counterpart: with no mode row to anchor it, a line or two under the
    // chooser's own footer is still the statusline, not resumed output.
    const tail = [
      RESET_FIRST,
      'Enter to confirm · Esc to cancel',
      '5h (14%) 18:50 | 7d (31%) Wed 12:00'
    ].join('\n')
    expect(readUsageLimitMenu(tail).state).toBe('live')
  })

  it('calls a tail with no numbered run at all dismissed', () => {
    expect(readUsageLimitMenu('⏺ Read(src/main/index.ts)\n⎿  Read 120 lines').state).toBe(
      'dismissed'
    )
  })
})

describe('isLiveUsageLimitMenu', () => {
  it('is true only for a trailing chooser with exactly one highlighted row', () => {
    expect(isLiveUsageLimitMenu(RESET_FIRST)).toBe(true)
    // No cursor row: not interactable, e.g. half-redrawn or copied text.
    expect(
      isLiveUsageLimitMenu('  1. Stop and wait for the limit to reset\n  2. Upgrade your plan')
    ).toBe(false)
    expect(isLiveUsageLimitMenu('no menu here')).toBe(false)
  })
})

describe('planUsageLimitResetSelection', () => {
  it('presses nothing when the reset option is already highlighted', () => {
    expect(planUsageLimitResetSelection(RESET_FIRST)).toBe(0)
  })

  it('walks down to the reset option when a paid option is highlighted', () => {
    expect(planUsageLimitResetSelection(RESET_LAST)).toBe(2)
  })

  it('walks up when the cursor sits below the reset option', () => {
    const tail = [
      '  1. Add funds to continue with usage credits',
      '  2. Stop and wait for the limit to reset',
      '❯ 3. Upgrade your plan'
    ].join('\n')
    expect(planUsageLimitResetSelection(tail)).toBe(-1)
  })

  it('refuses when no option matches the reset label', () => {
    const tail = ['❯ 1. Add funds to continue with usage credits', '  2. Upgrade your plan'].join(
      '\n'
    )
    expect(planUsageLimitResetSelection(tail)).toBeNull()
  })

  it('refuses when two options match the reset label', () => {
    const tail = [
      '❯ 1. Stop and wait for the limit to reset',
      '  2. Stop and wait for limit to reset (weekly)'
    ].join('\n')
    expect(planUsageLimitResetSelection(tail)).toBeNull()
  })

  it('refuses when the matching label also offers to spend money', () => {
    const tail = [
      '❯ 1. Upgrade your plan',
      '  2. Stop and wait for the limit to reset or add funds now'
    ].join('\n')
    expect(planUsageLimitResetSelection(tail)).toBeNull()
  })

  it('refuses when no row is highlighted', () => {
    const tail = [
      '  1. Stop and wait for the limit to reset',
      '  2. Add funds to continue with usage credits'
    ].join('\n')
    expect(planUsageLimitResetSelection(tail)).toBeNull()
  })
})

describe('isResetOptionSelected', () => {
  it('is true only once the cursor rests on the reset row', () => {
    expect(isResetOptionSelected(RESET_FIRST)).toBe(true)
    expect(isResetOptionSelected(RESET_LAST)).toBe(false)
    expect(isResetOptionSelected('no menu here')).toBe(false)
  })

  it('confirms a lone row left by the arrows, which no first reading would trust', () => {
    // Arrowing up to row 1 repaints the chooser and parks the cursor there, so
    // the read-back can find one row and a heading the CLI never reprinted.
    // Refusing here would abandon a chooser this code had already read as live
    // and just moved the highlight in — the 12-hour park the frame rule exists
    // to prevent, caused by the frame rule.
    const afterArrows = 'Claude usage limit reached.\n❯ 1. Stop and wait for the limit to reset'
    expect(isLiveUsageLimitMenu(afterArrows)).toBe(false)
    expect(isResetOptionSelected(afterArrows)).toBe(true)
  })

  it('still refuses a lone row whose label is not the reset one', () => {
    expect(isResetOptionSelected('some output\n❯ 1. Upgrade your plan')).toBe(false)
  })
})

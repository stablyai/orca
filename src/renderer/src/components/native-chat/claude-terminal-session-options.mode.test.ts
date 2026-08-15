import { describe, expect, it } from 'vitest'
import {
  readClaudeFastModeFromTerminalScreen,
  readClaudePermissionModeFromTerminalScreen,
  readClaudeSessionOptionsFromTerminalScreen
} from './claude-terminal-session-options'

/** The status line identifies itself, so the mode read needs no banner — the
 *  banner scrolls out of the viewport after the first screenful. */
const read = readClaudePermissionModeFromTerminalScreen

describe('permission mode from the status line', () => {
  it.each([
    ['⏸ manual mode on', 'manual'],
    ['▶▶ accept edits on', 'acceptEdits'],
    ['⏸ plan mode on', 'plan'],
    ['▶▶ auto mode on', 'auto'],
    ['▶▶ bypass permissions on', 'bypassPermissions']
  ])('reads %s', (line, expected) => {
    expect(read(`> \n${line}`)).toBe(expected)
  })

  it('reads the real prefix, hint and trailing history affordance', () => {
    const line = '▶▶ bypass permissions on (shift+tab to cycle) · ← for history'
    expect(read(`> \n${line}`)).toBe('bypassPermissions')
  })

  it('reads through trailing blank viewport rows', () => {
    expect(read(`> \n⏸ plan mode on${'\n'.repeat(20)}`)).toBe('plan')
  })

  it('prefers the indicator nearest the composer over stale text above it', () => {
    expect(read('▶▶ accept edits on\n> \n⏸ plan mode on')).toBe('plan')
  })
})

describe('permission mode: what must NOT be read as live status', () => {
  it('reports nothing when no indicator is present', () => {
    // Absence cannot mean manual: without the banner there is no proof this
    // screen is even Claude's.
    expect(read('some other program\n> ')).toBeNull()
  })

  it('ignores an indicator phrase inside conversation text', () => {
    expect(read('> how do I turn plan mode on?')).toBeNull()
    expect(read('> how do I turn manual mode on?')).toBeNull()
  })

  it('ignores a quoted indicator in an assistant reply', () => {
    expect(read('The status line shows plan mode on below.\n> ')).toBeNull()
  })

  it.each(['3. Auto mode on: fewer prompts', '- Plan mode on', '* Accept edits on'])(
    'ignores a list item posing as live status: %s',
    (item) => {
      expect(read(`${item}\n> `)).toBeNull()
    }
  )

  it('ignores an indicator that scrolled far above the composer', () => {
    const filler = Array.from({ length: 12 }, (_, index) => `output line ${index}`).join('\n')
    expect(read(`⏸ plan mode on\n${filler}\n> `)).toBeNull()
  })

  it('does not let blank-separated transcript text reach the window', () => {
    const spaced = ['1. Plan mode on: restricts edits', 'tool output', 'tool output', 'tool output']
      .map((line) => `${line}\n`)
      .join('\n')
    expect(read(`${spaced}\n> `)).toBeNull()
  })
})

describe('fast mode from the ↯ glyph', () => {
  // Why the glyph and not a command: `/fast` with no argument opens a
  // confirmation panel, so the picker sets `/fast on|off` and reads state here.
  it('reads fast mode as on when the glyph is present, with no banner', () => {
    expect(readClaudeFastModeFromTerminalScreen('Opus 4.8 ↯\n> ')).toBe(true)
  })

  it('reports nothing without the glyph, since absence is not proof of Claude', () => {
    expect(readClaudeFastModeFromTerminalScreen('Opus 4.8\n> ')).toBeNull()
  })

  it('ignores the glyph in the confirmation panel title', () => {
    const panel = '↯ Fast mode (research preview)\n  Fast mode  OFF  $10/$50 per Mtok'
    expect(readClaudeFastModeFromTerminalScreen(panel)).toBeNull()
  })

  it('reports a truthful off when the banner proves the screen is Claude', () => {
    const screen = '╭ Claude Code v2.1.220\n│ Opus 4.8 · with high effort\n╰\n> '
    expect(readClaudeSessionOptionsFromTerminalScreen(screen)?.fastMode).toBe(false)
  })

  it('reports on when the banner carries the glyph', () => {
    const screen = '╭ Claude Code v2.1.220\n│ Opus 4.8 ↯ · with high effort\n╰\n> '
    expect(readClaudeSessionOptionsFromTerminalScreen(screen)?.fastMode).toBe(true)
  })
})

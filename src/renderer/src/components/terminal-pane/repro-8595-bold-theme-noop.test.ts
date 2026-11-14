/**
 * Issue #8595 — "Bold Text" terminal color override is a no-op.
 *
 * terminalColorOverrides.bold is preserved in settings / Ghostty import and
 * spread into the composed ITheme, but xterm.js ITheme has no `bold` key so
 * the renderer never applies it to bold default-fg cells.
 *
 * Re-run:
 *   pnpm exec vitest run src/renderer/src/components/terminal-pane/repro-8595-bold-theme-noop.test.ts
 */
import type { ITheme } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import type { TerminalColorOverrides } from '../../../../shared/types'
import { composeActiveTerminalTheme } from './terminal-appearance'

// xterm ITheme public color slots used by the renderer (no `bold`).
const XTERM_ITHEME_COLOR_KEYS = [
  'foreground',
  'background',
  'cursor',
  'cursorAccent',
  'selectionBackground',
  'selectionForeground',
  'selectionInactiveBackground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const satisfies readonly (keyof ITheme)[]

describe('#8595 bold color override is present in settings shape but unused by ITheme', () => {
  it('documents that ITheme has no bold key among color slots', () => {
    expect(XTERM_ITHEME_COLOR_KEYS.includes('bold' as never)).toBe(false)
    // Compile-time: assigning bold is not a declared ITheme field
    const theme: ITheme = { foreground: '#fff', background: '#000' }
    expect('bold' in theme).toBe(false)
  })

  it('composeActiveTerminalTheme still spreads bold into the theme object (silent dead key)', () => {
    const baseTheme: ITheme = {
      foreground: '#cccccc',
      background: '#1e1e1e'
    }
    const overrides: TerminalColorOverrides = {
      bold: '#ffc600',
      red: '#ff0000'
    }

    const composed = composeActiveTerminalTheme(baseTheme, {
      terminalColorOverrides: overrides
    })

    expect(composed).not.toBeNull()
    // Settings-side value survives the spread (Ghostty bold-color / UI override)
    expect((composed as Record<string, string | undefined>).bold).toBe('#ffc600')
    // Known ITheme keys are applied
    expect(composed!.red).toBe('#ff0000')
    expect(composed!.foreground).toBe('#cccccc')

    // xterm only reads declared ITheme keys; `bold` is not one of them
    for (const key of XTERM_ITHEME_COLOR_KEYS) {
      // none of the canonical slots is named bold
      expect(key).not.toBe('bold')
    }
  })
})

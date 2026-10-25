import { describe, expect, it } from 'vitest'
import {
  neutralTerminalTitle,
  titleAfterConfirmedShell,
  titleAfterInferredInterrupt
} from './terminal-pane-title-reset'

describe('pane title resets', () => {
  it('names the neutral title after the tab default, else Terminal', () => {
    expect(neutralTerminalTitle(' Terminal 3 ')).toBe('Terminal 3')
    expect(neutralTerminalTitle('  ')).toBe('Terminal')
    expect(neutralTerminalTitle(undefined)).toBe('Terminal')
  })

  it('resets only an agent-named title on a confirmed return to a shell', () => {
    expect(titleAfterConfirmedShell('✳ Claude Code', 'Terminal 1')).toBe('Terminal 1')
    expect(titleAfterConfirmedShell('vim notes.md', 'Terminal 1')).toBeNull()
    expect(titleAfterConfirmedShell(null, 'Terminal 1')).toBeNull()
  })

  it('resets any shown title on an inferred interrupt', () => {
    expect(titleAfterInferredInterrupt('working', 'Terminal 1')).toBe('Terminal 1')
    expect(titleAfterInferredInterrupt('', 'Terminal 1')).toBeNull()
  })
})

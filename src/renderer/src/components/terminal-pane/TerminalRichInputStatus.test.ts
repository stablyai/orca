import { describe, expect, it } from 'vitest'
import {
  terminalRichInputNewlineShortcut,
  terminalRichInputStatusText
} from './TerminalRichInputStatus'

describe('terminalRichInputNewlineShortcut', () => {
  it('uses platform-correct Shift labels', () => {
    expect(terminalRichInputNewlineShortcut('darwin')).toBe('⇧+Enter')
    expect(terminalRichInputNewlineShortcut('linux')).toBe('Shift+Enter')
    expect(terminalRichInputNewlineShortcut('win32')).toBe('Shift+Enter')
  })
})

describe('terminalRichInputStatusText', () => {
  it('shows the send hint when nothing went wrong', () => {
    expect(terminalRichInputStatusText(null)).toContain('Enter to send')
  })

  it('distinguishes an unconfirmed send from an outright failure', () => {
    const unconfirmed = terminalRichInputStatusText('unconfirmed')
    const failed = terminalRichInputStatusText('not-started')
    // Why: an unconfirmed send most likely landed, so it must not read as "not sent".
    expect(unconfirmed).not.toBe(failed)
    expect(unconfirmed).toContain('Sent')
    expect(failed).toContain('not sent')
  })

  it('tells the user to check the terminal on a partial write', () => {
    expect(terminalRichInputStatusText('partially-written')).toContain('Check the terminal')
  })

  it('points every non-success state at the terminal', () => {
    for (const notice of ['unconfirmed', 'partially-written'] as const) {
      expect(terminalRichInputStatusText(notice)).toContain('terminal')
    }
  })
})

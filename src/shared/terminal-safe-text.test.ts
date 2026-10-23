import { describe, expect, it } from 'vitest'
import { terminalSafe, terminalSafeLine } from './terminal-safe-text'

describe('terminalSafe', () => {
  it('strips escape sequences a remote string could carry into the reader terminal', () => {
    expect(terminalSafe('before\u001b]52;c;cGF5bG9hZA==\u0007after')).toBe('beforeafter')
    expect(terminalSafe('red \u001b[31mtext\u001b[0m')).toBe('red text')
    expect(terminalSafe('clear\u001b[2Jscreen')).toBe('clearscreen')
    expect(terminalSafe('c1\u009b31mcsi\u0085')).toBe('c1csi')
  })

  it('keeps line breaks and tabs in multi-line text', () => {
    expect(terminalSafe('first\r\nsecond\n\tthird')).toBe('first\r\nsecond\n\tthird')
  })
})

describe('terminalSafeLine', () => {
  it('collapses line breaks so a value cannot spoof another output line', () => {
    expect(terminalSafeLine('Fix auth\r\nState: Done')).toBe('Fix auth State: Done')
    expect(terminalSafeLine('a\rb\n\nc')).toBe('a b c')
  })

  it('returns clean text unchanged', () => {
    expect(terminalSafeLine('  ENG-1 Fix auth\t')).toBe('  ENG-1 Fix auth\t')
  })
})

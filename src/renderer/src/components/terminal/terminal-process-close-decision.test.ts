import { describe, expect, it } from 'vitest'
import { resolveTerminalProcessCloseVerdict } from './terminal-process-close-decision'

describe('terminal close process verdict', () => {
  it('keeps a native-window close prompt for a mixed foreground-race result', () => {
    expect(
      resolveTerminalProcessCloseVerdict({
        foregroundProcess: null,
        hasChildProcesses: false,
        processEvidence: {
          foreground: { verdict: 'unverifiable', reason: 'foreground read raced exit' },
          children: { verdict: 'exited' }
        }
      })
    ).toBe('unverifiable')
  })

  it('keeps a split-pane close prompt for an unavailable result', () => {
    expect(
      resolveTerminalProcessCloseVerdict({
        foregroundProcess: null,
        hasChildProcesses: false,
        unavailable: true
      })
    ).toBe('unverifiable')
  })

  it('treats a remote result without processEvidence as unverifiable', () => {
    expect(
      resolveTerminalProcessCloseVerdict({
        foregroundProcess: 'zsh',
        hasChildProcesses: false
      })
    ).toBe('unverifiable')
  })
})

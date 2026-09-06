import { describe, expect, it, vi } from 'vitest'
import { sendHostedIosPastedTerminalCommand } from './hosted-ios-pasted-terminal-command'

const args = {
  deviceUdid: 'device',
  discoveryUrl: 'http://127.0.0.1:1234',
  orcaCli: '/orca',
  userDataDir: '/user-data',
  worktree: '/worktree'
}

describe('sendHostedIosPastedTerminalCommand', () => {
  it('retries a missed paste activation before pressing Enter', async () => {
    const pasteAttempts: string[] = []
    let captureAttempts = 0
    const result = await sendHostedIosPastedTerminalCommand(args, 'touch proof; ', {
      tapControl: vi.fn(async (_args, label) => {
        if (label === 'Paste') {
          pasteAttempts.push(label)
          return
        }
        throw new Error('Paste permission prompt not shown')
      }),
      waitForEvaluation: vi.fn(async (_url, _timeout, expression, accepted) => {
        if (expression.includes('__orcaTerminalInputCapture')) {
          captureAttempts += 1
          if (captureAttempts === 1) {
            throw new Error('first tap missed')
          }
          const value = '__ORCA_CLIPBOARD_PASTE__'
          expect(accepted(value)).toBe(true)
          return value
        }
        expect(accepted('clicked')).toBe(true)
        return 'clicked'
      }),
      writePasteboard: vi.fn(async () => undefined)
    })

    expect(pasteAttempts).toHaveLength(2)
    expect(result).toEqual({
      expected: '__ORCA_CLIPBOARD_PASTE__',
      requireCarriageReturn: true
    })
  })

  it('does not duplicate a successful paste activation', async () => {
    const tapControl = vi.fn(async (_args, label) => {
      if (label !== 'Paste') {
        throw new Error('Paste permission prompt not shown')
      }
    })
    const waitForEvaluation = vi.fn(async (_url, _timeout, expression, accepted) => {
      const value = expression.includes('__orcaTerminalInputCapture')
        ? '__ORCA_CLIPBOARD_PASTE__'
        : 'clicked'
      expect(accepted(value)).toBe(true)
      return value
    })

    await sendHostedIosPastedTerminalCommand(args, 'touch proof; ', {
      tapControl,
      waitForEvaluation,
      writePasteboard: vi.fn(async () => undefined)
    })

    expect(tapControl.mock.calls.filter(([, label]) => label === 'Paste')).toHaveLength(1)
  })
})

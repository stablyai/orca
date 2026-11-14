import { expect, it } from 'vitest'
import { humanizeTerminalError } from './terminal-error-display'
import { formatAccountRestartFailure } from '../../../../../shared/terminal/pty/lifecycle/account-restart-contract'

it('keeps diagnostics readable while the transport carries restart proof for each failed attempt', () => {
  const input = [
    formatAccountRestartFailure('First launch refused.', {
      v: 1,
      requestId: 'request-1',
      attemptId: 'attempt-1',
      stop: 'not-started',
      outcome: 'terminal'
    }),
    formatAccountRestartFailure('Second launch refused.', {
      v: 1,
      requestId: 'request-2',
      attemptId: 'attempt-2',
      stop: 'confirmed-retired',
      outcome: 'terminal'
    })
  ].join('\n')
  expect(humanizeTerminalError(input, undefined, (_key, fallback) => fallback)).toBe(
    'First launch refused.\nSecond launch refused.'
  )
})

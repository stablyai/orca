import { expect, it } from 'vitest'
import { formatAccountRestartFailure, readAccountRestartReceipt } from './account-restart-contract'

it.each(['界', '\u0000'])(
  'round-trips the accepted receipt token byte domain for %j',
  (character) => {
    const expected = {
      v: 1 as const,
      requestId: character.repeat(128),
      attemptId: character.repeat(128),
      stop: 'not-started' as const,
      outcome: 'terminal' as const,
      current: {
        kind: 'original' as const,
        bindingGeneration: 0,
        incarnationId: character.repeat(128)
      }
    }
    expect(
      readAccountRestartReceipt(formatAccountRestartFailure('launch refused', expected))
    ).toEqual(expected)
  }
)
it('refuses overlength receipt tokens and oversized encoded input', () => {
  expect(
    readAccountRestartReceipt(
      formatAccountRestartFailure('refused', {
        v: 1,
        requestId: 'x'.repeat(129),
        attemptId: 'attempt',
        stop: 'unknown'
      })
    )
  ).toBeUndefined()
  expect(
    readAccountRestartReceipt(`terminal_account_restart_v1:${'e'.repeat(10000)}`)
  ).toBeUndefined()
})

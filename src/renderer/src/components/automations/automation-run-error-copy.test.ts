import { describe, expect, it } from 'vitest'
import { automationRunErrorText } from './automation-run-error-copy'

describe('automation startup failure copy', () => {
  it('shows recovery steps for a typed Codex bootstrap failure from the host', () => {
    expect(
      automationRunErrorText({
        errorCode: 'codexBootstrapFailed',
        error: 'Host startup failure'
      })
    ).toBe(
      'Codex could not read its account during startup. Open Codex on this host and check account access. After Codex starts successfully, use Run now to retry this automation.'
    )
  })
})

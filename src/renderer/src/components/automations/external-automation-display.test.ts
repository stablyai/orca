import { describe, expect, it } from 'vitest'
import { isMissingExternalRunsApiError } from './external-automation-display'
import { EXTERNAL_AUTOMATION_SCOPE_CODES } from '../../../../shared/external-automation-scope'

describe('isMissingExternalRunsApiError', () => {
  it('recognizes the relay code carried in the message', () => {
    // Electron IPC keeps only the message, so the code rides inside it.
    expect(
      isMissingExternalRunsApiError(
        new Error(
          `Error invoking remote method: This host does not report external automation run history.: ${EXTERNAL_AUTOMATION_SCOPE_CODES.runsUnsupported}`
        )
      )
    ).toBe(true)
  })

  it('still recognizes hosts that answer with no code at all', () => {
    expect(
      isMissingExternalRunsApiError(new Error("No handler registered for 'automations:listRuns'"))
    ).toBe(true)
    expect(isMissingExternalRunsApiError(new Error('listExternalRuns is not a function'))).toBe(
      true
    )
  })

  it('does not treat an ordinary relay failure as a missing endpoint', () => {
    // Falling back here would render a truncated run list as if it were complete.
    expect(isMissingExternalRunsApiError(new Error('SSH target "ssh-1" is not connected.'))).toBe(
      false
    )
    expect(isMissingExternalRunsApiError(new Error('socket hang up'))).toBe(false)
  })
})

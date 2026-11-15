import { describe, expect, it } from 'vitest'
import { computerUseErrorRecoveryData } from './computer-use-error-recovery'

describe('computerUseErrorRecoveryData', () => {
  it('sends a secure-input refusal to the user instead of a retry', () => {
    const steps = computerUseErrorRecoveryData('secure_input_active')?.nextSteps.join('\n')
    expect(steps).toContain('Ask the user')
    expect(steps).not.toContain('--restore-window')
  })

  it('retries a typing refusal after a pause, never in the foreground', () => {
    const steps = computerUseErrorRecoveryData('user_actively_typing')?.nextSteps.join('\n')
    expect(steps).toContain('Wait a few seconds and retry')
    expect(steps).not.toContain('--restore-window')
  })
})

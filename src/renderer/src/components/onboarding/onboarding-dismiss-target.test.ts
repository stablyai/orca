import { describe, expect, it, vi } from 'vitest'
import { shouldRequestOnboardingSkipConfirmation } from './onboarding-dismiss-target'

function createTarget(matchingSelectorFragment: string | null): EventTarget {
  return {
    closest: vi.fn((selector: string) => {
      if (matchingSelectorFragment && selector.includes(matchingSelectorFragment)) {
        return {}
      }
      return null
    })
  } as unknown as EventTarget
}

describe('shouldRequestOnboardingSkipConfirmation', () => {
  it('requests confirmation for primary clicks outside onboarding UI', () => {
    expect(shouldRequestOnboardingSkipConfirmation({ button: 0, target: createTarget(null) })).toBe(
      true
    )
  })

  it('ignores non-primary clicks', () => {
    expect(shouldRequestOnboardingSkipConfirmation({ button: 2, target: createTarget(null) })).toBe(
      false
    )
  })

  it('ignores clicks inside the onboarding modal', () => {
    expect(
      shouldRequestOnboardingSkipConfirmation({
        button: 0,
        target: createTarget('data-onboarding-modal')
      })
    ).toBe(false)
  })

  it('ignores clicks inside nested Radix dialog portals', () => {
    expect(
      shouldRequestOnboardingSkipConfirmation({
        button: 0,
        target: createTarget('data-slot="dialog-content"')
      })
    ).toBe(false)
    expect(
      shouldRequestOnboardingSkipConfirmation({
        button: 0,
        target: createTarget('data-slot="dialog-overlay"')
      })
    ).toBe(false)
  })

  it('ignores clicks inside notification sound select content', () => {
    expect(
      shouldRequestOnboardingSkipConfirmation({
        button: 0,
        target: createTarget('data-slot="select-content"')
      })
    ).toBe(false)
  })
})

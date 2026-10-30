import { describe, expect, it } from 'vitest'
import {
  shouldRequestBrowserExtensionsTour,
  type BrowserExtensionsTourEligibilityInput
} from './use-browser-extensions-tour'

const SESSION_STARTED_AT = 1_000_000

function input(
  overrides: Partial<BrowserExtensionsTourEligibilityInput> = {}
): BrowserExtensionsTourEligibilityInput {
  return {
    persistedUIReady: true,
    extensionsEnabled: true,
    seenIds: [],
    tourShownThisSession: false,
    onboardingVisible: false,
    autoEligible: false,
    featureInteractions: {
      browser: { firstInteractedAt: SESSION_STARTED_AT - 1, interactionCount: 3 }
    },
    sessionStartedAt: SESSION_STARTED_AT,
    ...overrides
  }
}

describe('shouldRequestBrowserExtensionsTour', () => {
  it('shows on a browser visit in a later session than the first one', () => {
    expect(shouldRequestBrowserExtensionsTour(input())).toBe(true)
  })

  it('leaves the first browser session to Import', () => {
    expect(
      shouldRequestBrowserExtensionsTour(
        input({
          featureInteractions: {
            browser: { firstInteractedAt: SESSION_STARTED_AT + 5, interactionCount: 1 }
          }
        })
      )
    ).toBe(false)
    expect(shouldRequestBrowserExtensionsTour(input({ featureInteractions: {} }))).toBe(false)
  })

  it('never shows twice', () => {
    expect(shouldRequestBrowserExtensionsTour(input({ seenIds: ['browser-extensions'] }))).toBe(
      false
    )
  })

  it('waits when another tour already ran this session', () => {
    expect(shouldRequestBrowserExtensionsTour(input({ tourShownThisSession: true }))).toBe(false)
  })

  it('lets auto-tour users finish the browser tour (with its Import step) first', () => {
    expect(shouldRequestBrowserExtensionsTour(input({ autoEligible: true }))).toBe(false)
    expect(
      shouldRequestBrowserExtensionsTour(input({ autoEligible: true, seenIds: ['browser'] }))
    ).toBe(true)
  })

  it('reaches users who never got automatic tours', () => {
    expect(shouldRequestBrowserExtensionsTour(input({ autoEligible: null }))).toBe(true)
  })

  it('skips people who already opened the extensions menu', () => {
    expect(
      shouldRequestBrowserExtensionsTour(
        input({
          featureInteractions: {
            browser: { firstInteractedAt: 1, interactionCount: 3 },
            'browser-extensions': { firstInteractedAt: 2, interactionCount: 1 }
          }
        })
      )
    ).toBe(false)
  })

  it('stays quiet while extensions are off, onboarding is up, or UI state is loading', () => {
    expect(shouldRequestBrowserExtensionsTour(input({ extensionsEnabled: false }))).toBe(false)
    expect(shouldRequestBrowserExtensionsTour(input({ onboardingVisible: true }))).toBe(false)
    expect(shouldRequestBrowserExtensionsTour(input({ persistedUIReady: false }))).toBe(false)
  })
})

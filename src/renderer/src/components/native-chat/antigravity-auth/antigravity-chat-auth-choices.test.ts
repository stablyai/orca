import { describe, expect, it } from 'vitest'
import type { AntigravityChatAuthDetection } from '../../../../../shared/rpc-contract/accounts/antigravity-accounts-params'
import { ANTIGRAVITY_ACCOUNT_INELIGIBLE } from '../../../../../shared/agent-accounts/antigravity/antigravity-sign-in-sentences'
import {
  antigravityAuthFailureOutlived,
  antigravityAuthFailureReason,
  antigravityChatAuthAlternatives,
  antigravityChatAuthMenuItems
} from './antigravity-chat-auth-choices'

const detection = (
  patch: Partial<AntigravityChatAuthDetection> = {}
): AntigravityChatAuthDetection => ({
  method: 'oauth-personal',
  googleSignIn: { personal: false, business: false },
  apiKey: { available: true, source: 'environment' },
  adc: { available: true, project: 'my-project' },
  liveChats: 0,
  ...patch
})

describe('antigravityChatAuthAlternatives', () => {
  it('ranks a detected key before gcloud, and leaves out the method in use', () => {
    expect(antigravityChatAuthAlternatives(detection())).toEqual([
      { method: 'gemini-api-key', source: 'environment' },
      { method: 'agent-platform', project: 'my-project' }
    ])
    expect(
      antigravityChatAuthAlternatives(
        detection({ method: 'gemini-api-key', googleSignIn: { personal: true, business: false } })
      )
    ).toEqual([{ method: 'agent-platform', project: 'my-project' }, { method: 'oauth-personal' }])
  })

  it('offers gcloud only with a project it can use, and nothing without detections', () => {
    expect(
      antigravityChatAuthAlternatives(
        detection({
          apiKey: { available: false, source: null },
          adc: { available: true, project: null }
        })
      )
    ).toEqual([])
    expect(antigravityChatAuthAlternatives(null)).toEqual([])
  })
})

describe('antigravityChatAuthMenuItems', () => {
  it('keeps a fixed order, marks the active method and tags detected ones', () => {
    const items = antigravityChatAuthMenuItems(
      detection({ method: 'gemini-api-key', googleSignIn: { personal: true, business: false } }),
      true
    )
    expect(items).toEqual([
      { method: 'oauth-personal', active: false, detected: true, opensSettings: false },
      { method: 'oauth-business', active: false, detected: false, opensSettings: true },
      { method: 'gemini-api-key', active: true, detected: true, opensSettings: false },
      { method: 'agent-platform', active: false, detected: true, opensSettings: false }
    ])
  })

  it('sends undetected key and gcloud methods to Settings, and hides them from older hosts', () => {
    const none = detection({
      apiKey: { available: false, source: null },
      adc: { available: false, project: null }
    })
    expect(
      antigravityChatAuthMenuItems(none, true)
        .filter((item) => item.opensSettings)
        .map((item) => item.method)
    ).toEqual(['oauth-business', 'gemini-api-key', 'agent-platform'])
    expect(antigravityChatAuthMenuItems(none, false).map((item) => item.method)).toEqual([
      'oauth-personal',
      'oauth-business'
    ])
  })
})

describe('antigravityAuthFailureReason', () => {
  it.each([
    [{ text: 'error: SUBSCRIPTION_REQUIRED' }, 'noSubscription'],
    [{ text: ANTIGRAVITY_ACCOUNT_INELIGIBLE }, 'ineligible'],
    [{ text: 'Usage limit reached for this account' }, 'usageLimit'],
    [{ failureKind: 'usageLimitReached', text: '' }, 'usageLimit'],
    [{ failureKind: 'notSignedIn', text: '' }, 'signedOut'],
    [{ text: '403 PERMISSION_DENIED: caller does not have permission' }, 'refused'],
    [{ text: 'Request failed with status 401 Unauthorized' }, 'refused'],
    // A tool's own request failing says nothing about the chat's sign-in.
    [{ text: 'fetch https://example.com returned 403' }, null],
    [{ text: 'HTTP 429 from the docs site' }, null],
    [{ text: 'The model is overloaded' }, null],
    // The host's own agy keeps agy's login.
    [{ failureKind: 'notSignedIn', account: 'system', text: '403' }, null]
  ] as const)('%o is %s', (input, reason) => {
    expect(antigravityAuthFailureReason(input)).toBe(reason)
  })
})

describe('antigravityAuthFailureOutlived', () => {
  it('drops an offer once the chat left the method that failed', () => {
    const rejected = 'API key not valid. Please pass a valid API key.'
    expect(antigravityAuthFailureOutlived('refused', rejected, 'agent-platform')).toBe(true)
    expect(antigravityAuthFailureOutlived('refused', rejected, 'gemini-api-key')).toBe(false)
    expect(antigravityAuthFailureOutlived('noSubscription', '', 'gemini-api-key')).toBe(true)
    expect(antigravityAuthFailureOutlived('noSubscription', '', 'oauth-personal')).toBe(false)
    expect(antigravityAuthFailureOutlived('refused', 'PERMISSION_DENIED', 'agent-platform')).toBe(
      false
    )
  })
})

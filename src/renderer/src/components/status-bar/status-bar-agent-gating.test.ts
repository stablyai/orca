import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { isStatusBarItemAvailable } from './status-bar-agent-gating'

function antigravitySnapshot(
  status: ProviderRateLimits['status'],
  failureKind?: 'usage-unavailable' | 'cli-unavailable'
): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: 1,
    error: status === 'error' ? 'Quota unavailable' : null,
    status,
    usageMetadata: failureKind
      ? {
          source: 'live-session',
          attemptedSources: ['live-session'],
          failureKind,
          credentialSource: 'agy-local-service',
          authProvenance: 'antigravity'
        }
      : undefined
  }
}

describe('isStatusBarItemAvailable', () => {
  it('shows non-CLI items regardless of detection', () => {
    // Why: ssh, resource-usage, and opencode-go aren't CLIs on PATH, so
    // detection results don't apply.
    expect(isStatusBarItemAvailable('ssh', null)).toBe(true)
    expect(isStatusBarItemAvailable('ssh', [])).toBe(true)
    expect(isStatusBarItemAvailable('resource-usage', [])).toBe(true)
    expect(isStatusBarItemAvailable('ports', [])).toBe(true)
    expect(isStatusBarItemAvailable('opencode-go', [])).toBe(true)
  })

  it('keeps CLI items visible while detection is in flight', () => {
    // Why: pre-detection (null) we don't yet know what the user has, so we
    // don't want a flash of empty status bar on cold start.
    expect(isStatusBarItemAvailable('claude', null)).toBe(true)
    expect(isStatusBarItemAvailable('codex', null)).toBe(true)
    expect(isStatusBarItemAvailable('gemini', null)).toBe(true)
    expect(isStatusBarItemAvailable('antigravity', null)).toBe(true)
    expect(isStatusBarItemAvailable('grok', null)).toBe(true)
  })

  it('hides CLI items not detected on PATH', () => {
    expect(isStatusBarItemAvailable('claude', [])).toBe(false)
    expect(isStatusBarItemAvailable('codex', ['claude'])).toBe(false)
    expect(isStatusBarItemAvailable('gemini', ['claude', 'codex'])).toBe(false)
    expect(isStatusBarItemAvailable('grok', ['claude', 'kimi'])).toBe(false)
  })

  it('shows CLI items detected on PATH', () => {
    expect(isStatusBarItemAvailable('claude', ['claude'])).toBe(true)
    expect(isStatusBarItemAvailable('codex', ['codex', 'claude'])).toBe(true)
    expect(isStatusBarItemAvailable('gemini', ['gemini'])).toBe(true)
    expect(isStatusBarItemAvailable('grok', ['grok'])).toBe(true)
  })

  it('shows Antigravity for a desktop-only runtime snapshot', () => {
    expect(
      isStatusBarItemAvailable('antigravity', ['claude', 'codex'], antigravitySnapshot('ok'))
    ).toBe(true)
    expect(
      isStatusBarItemAvailable(
        'antigravity',
        ['claude', 'codex'],
        antigravitySnapshot('error', 'usage-unavailable')
      )
    ).toBe(true)
  })

  it('hides Antigravity after runtime discovery confirms it is unavailable', () => {
    expect(
      isStatusBarItemAvailable(
        'antigravity',
        ['claude', 'codex'],
        antigravitySnapshot('unavailable', 'cli-unavailable')
      )
    ).toBe(false)
    expect(
      isStatusBarItemAvailable(
        'antigravity',
        ['claude', 'codex'],
        antigravitySnapshot('fetching', 'cli-unavailable')
      )
    ).toBe(false)
  })

  it('shows Antigravity when its CLI is detected before a runtime snapshot arrives', () => {
    expect(isStatusBarItemAvailable('antigravity', ['antigravity'])).toBe(true)
  })
})

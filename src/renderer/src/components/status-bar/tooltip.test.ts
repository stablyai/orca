import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import {
  formatResetCountdown,
  getProviderUsageErrorMessage,
  getProviderUsageStatusLabel,
  getWindowSections
} from './tooltip'

function provider(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status: 'error',
    ...overrides
  }
}

describe('formatResetCountdown', () => {
  it('uses natural copy when the reset time has arrived', () => {
    expect(formatResetCountdown(0)).toBe('Resets now')
    expect(formatResetCountdown(-1)).toBe('Resets now')
  })

  it('keeps the "in" preposition for future reset times', () => {
    expect(formatResetCountdown(12 * 60 * 60_000 + 41 * 60_000)).toBe('Resets in 12h 41m')
  })
})

describe('provider usage error copy', () => {
  it('frames Claude auth-shaped usage failures as usage refresh failures', () => {
    const p = provider({ error: 'Invalid authentication credentials' })

    expect(getProviderUsageStatusLabel(p)).toBe('Refresh failed')
    expect(getProviderUsageErrorMessage(p)).toBe(
      'Claude usage could not be refreshed. Agent sessions may still be signed in.'
    )
  })

  it('frames provider credential and session failures without showing raw auth details', () => {
    const codex = provider({
      provider: 'codex',
      error:
        'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.'
    })
    const gemini = provider({
      provider: 'gemini',
      error: 'Gemini CLI credentials not found'
    })

    expect(getProviderUsageStatusLabel(codex)).toBe('Refresh failed')
    expect(getProviderUsageErrorMessage(codex)).toBe(
      'Codex usage could not be refreshed. Agent sessions may still be signed in.'
    )
    expect(getProviderUsageErrorMessage(gemini)).toBe(
      'Gemini usage could not be refreshed. Agent sessions may still be signed in.'
    )
  })

  it('frames credential-file and login failures as auth-shaped usage failures', () => {
    const kimi = provider({
      provider: 'kimi',
      error: 'Kimi credentials-file is invalid'
    })
    const opencodeGo = provider({
      provider: 'opencode-go',
      error: 'Please log in before refreshing usage.'
    })

    expect(getProviderUsageErrorMessage(kimi)).toBe(
      'Kimi usage could not be refreshed. Agent sessions may still be signed in.'
    )
    expect(getProviderUsageErrorMessage(opencodeGo)).toBe(
      'OpenCode Go usage could not be refreshed. Agent sessions may still be signed in.'
    )
  })

  it('frames known Codex auth refresh failures as auth-shaped usage failures', () => {
    const cases = [
      'Please reauthenticate before checking usage.',
      'Not logged in.',
      'Token data is not available.',
      'Auth is missing.',
      'Auth tokens are missing.',
      'Auth does not expose access tokens.'
    ]

    for (const error of cases) {
      expect(getProviderUsageErrorMessage(provider({ provider: 'codex', error }))).toBe(
        'Codex usage could not be refreshed. Agent sessions may still be signed in.'
      )
    }
  })

  it('keeps rate-limit failures distinct from refresh failures', () => {
    const p = provider({ error: 'Claude usage is rate limited right now.' })

    expect(getProviderUsageStatusLabel(p)).toBe('Limited')
    expect(getProviderUsageErrorMessage(p)).toBe('Claude usage is rate limited right now.')
  })

  it('lets rate-limit copy win when the detail also mentions auth', () => {
    const p = provider({
      error: 'Rate limit reached while refreshing OAuth access token.'
    })

    expect(getProviderUsageStatusLabel(p)).toBe('Limited')
    expect(getProviderUsageErrorMessage(p)).toBe(
      'Rate limit reached while refreshing OAuth access token.'
    )
  })

  it('keeps generic OAuth and network failures as raw refresh details', () => {
    const oauth = provider({ error: 'OAuth API returned 500' })
    const network = provider({ error: 'Network error while refreshing OAuth usage: ECONNRESET' })

    expect(getProviderUsageStatusLabel(oauth)).toBe('Refresh failed')
    expect(getProviderUsageErrorMessage(oauth)).toBe('OAuth API returned 500')
    expect(getProviderUsageErrorMessage(network)).toBe(
      'Network error while refreshing OAuth usage: ECONNRESET'
    )
  })

  it('keeps live-Claude refresh deferral copy visible', () => {
    const p = provider({
      error:
        'Claude usage refresh is waiting for the live Claude terminal to rotate its credentials.'
    })

    expect(getProviderUsageErrorMessage(p)).toBe(
      'Claude usage refresh is waiting for the live Claude terminal to rotate its credentials.'
    )
  })
})

describe('getWindowSections', () => {
  it('returns buckets as sections when present', () => {
    const p: ProviderRateLimits = {
      provider: 'gemini',
      session: { usedPercent: 80, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      buckets: [
        {
          name: 'Pro',
          usedPercent: 30,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        },
        {
          name: 'Flash',
          usedPercent: 80,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        }
      ],
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
    const sections = getWindowSections(p)
    expect(sections).toEqual([
      { label: 'Pro', window: p.buckets![0] },
      { label: 'Flash', window: p.buckets![1] },
      { label: 'Weekly', window: null }
    ])
  })

  it('returns session and weekly when buckets are absent', () => {
    const p: ProviderRateLimits = {
      provider: 'claude',
      session: { usedPercent: 40, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: { usedPercent: 20, windowMinutes: 10080, resetsAt: null, resetDescription: null },
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
    const sections = getWindowSections(p)
    expect(sections).toEqual([
      { label: 'Session', window: p.session },
      { label: 'Weekly', window: p.weekly }
    ])
  })

  it('returns session and weekly for empty buckets array', () => {
    const p: ProviderRateLimits = {
      provider: 'gemini',
      session: { usedPercent: 50, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      buckets: [],
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
    const sections = getWindowSections(p)
    expect(sections).toEqual([
      { label: 'Session', window: p.session },
      { label: 'Weekly', window: null }
    ])
  })

  it('does not expose bucket names via session window in compact rendering path', () => {
    // Why: ProviderSegment (compact mode) reads only p.session — never p.buckets.
    // This test locks the contract: getWindowSections returns buckets for detail
    // views, while the plain session value remains independently available for
    // compact rendering without bucket names bleeding through.
    const p: ProviderRateLimits = {
      provider: 'gemini',
      session: { usedPercent: 80, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      buckets: [
        {
          name: 'Pro',
          usedPercent: 30,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        },
        {
          name: 'Flash',
          usedPercent: 80,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        }
      ],
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
    // Compact path uses p.session directly — independent of getWindowSections.
    expect(p.session?.usedPercent).toBe(80)
    // getWindowSections (detail path) returns bucket rows, not session label.
    const sections = getWindowSections(p)
    const labels = sections.map((s) => s.label)
    expect(labels).toContain('Pro')
    expect(labels).toContain('Flash')
    expect(labels).not.toContain('Session')
  })

  it('preserves reset metadata inside bucket windows', () => {
    const p: ProviderRateLimits = {
      provider: 'gemini',
      session: null,
      weekly: null,
      buckets: [
        {
          name: 'Pro',
          usedPercent: 45,
          windowMinutes: 300,
          resetsAt: 18000000,
          resetDescription: '5:00 PM'
        }
      ],
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
    const sections = getWindowSections(p)
    expect(sections).toHaveLength(2)
    expect(sections[0].label).toBe('Pro')
    expect(sections[0].window!.resetsAt).toBe(18000000)
    expect(sections[0].window!.resetDescription).toBe('5:00 PM')
  })
})

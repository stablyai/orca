import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type * as ReactModule from 'react'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

vi.mock('@/lib/agent-catalog', async () => {
  const ReactActual = await vi.importActual<typeof ReactModule>('react')
  return {
    AgentIcon: ({ agent }: { agent: string }) =>
      ReactActual.createElement('span', { 'data-agent-icon': agent })
  }
})

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${key}}}`, value)
    }
    return result
  }
}))

import {
  barColor,
  clampUsedPercent,
  formatResetCreditExpiry,
  formatResetCountdown,
  getProviderUsageErrorMessage,
  getProviderUsageStatusLabel,
  getWindowSections,
  ProviderIcon,
  ProviderPanel
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

afterEach(() => {
  vi.useRealTimers()
})

describe('formatResetCountdown', () => {
  it('uses natural copy when the reset time has arrived', () => {
    expect(formatResetCountdown(0)).toBe('Resets now')
    expect(formatResetCountdown(-1)).toBe('Resets now')
  })

  it('keeps the "in" preposition for future reset times', () => {
    expect(formatResetCountdown(12 * 60 * 60_000 + 41 * 60_000)).toBe('Resets in 12h 41m')
  })
})

describe('formatResetCreditExpiry', () => {
  it('shows singular and plural expiry countdowns', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-20T12:00:00Z'))

    expect(formatResetCreditExpiry(Date.parse('2026-06-20T14:30:00Z'), 1)).toBe('Expires in 2h 30m')
    expect(formatResetCreditExpiry(Date.parse('2026-06-25T12:00:00Z'), 2)).toBe(
      'Next expires in 5d'
    )
  })

  it('omits expiry copy when the backend has not reported an expiry', () => {
    expect(formatResetCreditExpiry(null, 1)).toBeNull()
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
        'Claude usage refresh is waiting for the live Claude terminal to rotate its credentials.',
      usageMetadata: {
        failureKind: 'deferred-by-live-session',
        deferredByLiveClaudeSession: true
      }
    })

    expect(getProviderUsageStatusLabel(p)).toBe('Waiting for Claude session')
    expect(getProviderUsageErrorMessage(p)).toBe(
      'Claude usage will refresh after the live Claude terminal rotates its credentials.'
    )
  })

  it('uses structured Claude failure kinds before raw auth regexes', () => {
    const p = provider({
      error: 'Invalid OAuth token.',
      usageMetadata: {
        failureKind: 'stale-token',
        attemptedSources: ['oauth', 'cli']
      }
    })

    expect(getProviderUsageStatusLabel(p)).toBe('Refreshing sign-in')
    expect(getProviderUsageErrorMessage(p)).toBe(
      'Claude sign-in is being refreshed. Agent sessions may still be signed in.'
    )
  })

  it('uses structured network copy for Claude usage failures', () => {
    const p = provider({
      error: 'Network error while refreshing OAuth usage: ECONNRESET',
      usageMetadata: { failureKind: 'network' }
    })

    expect(getProviderUsageStatusLabel(p)).toBe('Network issue')
    expect(getProviderUsageErrorMessage(p)).toBe(
      'Claude usage could not be refreshed because the network request failed.'
    )
  })

  it('uses structured Keychain copy for Claude usage failures', () => {
    const p = provider({
      error: 'Claude Keychain credentials unavailable',
      usageMetadata: { failureKind: 'keychain-unavailable' }
    })

    expect(getProviderUsageStatusLabel(p)).toBe('Sign-in unavailable')
    expect(getProviderUsageErrorMessage(p)).toBe('Claude sign-in credentials could not be read.')
  })

  it('uses structured unavailable copy for Claude CLI usage shell failures', () => {
    const p = provider({
      error: 'Claude plan usage is unavailable for this Claude CLI session.',
      usageMetadata: { failureKind: 'usage-unavailable' }
    })

    expect(getProviderUsageStatusLabel(p)).toBe('Usage unavailable')
    expect(getProviderUsageErrorMessage(p)).toBe('Claude usage is unavailable right now.')
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

  it('returns a separate Fable section when Claude reports Fable weekly usage', () => {
    const p: ProviderRateLimits = {
      provider: 'claude',
      session: { usedPercent: 40, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: { usedPercent: 20, windowMinutes: 10080, resetsAt: null, resetDescription: null },
      fableWeekly: {
        usedPercent: 42,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: null
      },
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
    const sections = getWindowSections(p)
    expect(sections).toEqual([
      { label: 'Session', window: p.session },
      { label: 'Weekly', window: p.weekly },
      { label: 'Fable', window: p.fableWeekly }
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

describe('ProviderPanel reset rendering', () => {
  it('renders the Fable reset countdown when Claude reports a reset timestamp', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 3, 20, 0))
    const p = provider({
      status: 'ok',
      session: null,
      weekly: null,
      fableWeekly: {
        usedPercent: 62,
        windowMinutes: 10080,
        resetsAt: Date.now() + (6 * 24 + 17) * 60 * 60_000,
        resetDescription: 'Jul 10 at 1:00 PM'
      }
    })

    const markup = renderToStaticMarkup(ProviderPanel({ p }))

    expect(markup).toContain('Fable')
    expect(markup).toContain('Resets in 6d 17h')
  })

  it('renders MiniMax session as usedPercent so the value matches the bar', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 4, 15, 0))
    const p = provider({
      provider: 'minimax',
      status: 'ok',
      session: {
        usedPercent: 35,
        windowMinutes: 300,
        resetsAt: Date.now() + 2 * 60 * 60_000,
        resetDescription: null
      }
    })

    const markup = renderToStaticMarkup(ProviderPanel({ p }))

    // Why: bars show consumption (% used), matching harness meters (#7551).
    expect(markup).toContain('35%')
    expect(markup).toContain('% used')
    expect(markup).not.toContain('% left')
  })

  it('clamps MiniMax session to 100% used when usedPercent reports 100', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 4, 15, 0))
    const p = provider({
      provider: 'minimax',
      status: 'ok',
      session: {
        usedPercent: 100,
        windowMinutes: 300,
        resetsAt: Date.now() + 2 * 60 * 60_000,
        resetDescription: null
      }
    })

    const markup = renderToStaticMarkup(ProviderPanel({ p }))

    expect(markup).toContain('100%')
    expect(markup).toContain('% used')
  })

  it('clamps over-100 usedPercent to 100% used in the panel', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 4, 15, 0))
    const p = provider({
      provider: 'minimax',
      status: 'ok',
      session: {
        usedPercent: 140,
        windowMinutes: 300,
        resetsAt: Date.now() + 2 * 60 * 60_000,
        resetDescription: null
      }
    })

    const markup = renderToStaticMarkup(ProviderPanel({ p }))

    expect(markup).toContain('100%')
    expect(markup).toContain('width:100%')
    expect(markup).not.toContain('140%')
  })
})

describe('clampUsedPercent', () => {
  it('rounds and clamps into 0–100', () => {
    expect(clampUsedPercent(-3)).toBe(0)
    expect(clampUsedPercent(32.4)).toBe(32)
    expect(clampUsedPercent(32.6)).toBe(33)
    expect(clampUsedPercent(100)).toBe(100)
    expect(clampUsedPercent(140)).toBe(100)
  })
})

describe('barColor', () => {
  // Why: thresholds are on % used (consumption). Guard against flipping back
  // to remaining-based colors without noticing.
  it('maps used percent to green / yellow / red bands', () => {
    expect(barColor(0)).toBe('bg-green-500')
    expect(barColor(59)).toBe('bg-green-500')
    expect(barColor(60)).toBe('bg-yellow-500')
    expect(barColor(79)).toBe('bg-yellow-500')
    expect(barColor(80)).toBe('bg-red-500')
    expect(barColor(100)).toBe('bg-red-500')
  })
})

describe('ProviderIcon', () => {
  it('renders the Antigravity agent icon for the antigravity provider', () => {
    const markup = renderToStaticMarkup(ProviderIcon({ provider: 'antigravity' }))
    expect(markup).toContain('data-agent-icon="antigravity"')
  })

  it('renders the official MiniMax icon asset for the minimax provider', () => {
    // Why: the icon must travel to the status bar / tooltip unchanged so the
    // user recognises the brand. We pin it to an <img> with a non-empty
    // resource URL and aria-hidden so the icon stays purely decorative.
    const markup = renderToStaticMarkup(ProviderIcon({ provider: 'minimax' }))
    expect(markup.startsWith('<img')).toBe(true)
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toMatch(/src="[^"]+"/)
  })
})

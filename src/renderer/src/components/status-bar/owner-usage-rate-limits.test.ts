import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import { resolveOwnerUsageRateLimits } from './owner-usage-rate-limits'
import { getProviderUsageErrorMessage, getProviderUsageStatusLabel } from './usage-error-copy'

function provider(id: ProviderRateLimits['provider'], usedPercent: number): ProviderRateLimits {
  return {
    provider: id,
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok'
  }
}

const local = createEmptyRateLimitState({
  claude: provider('claude', 11),
  codex: provider('codex', 22),
  grok: provider('grok', 33),
  grokAuthConfigured: true
})

describe('resolveOwnerUsageRateLimits', () => {
  it('passes local usage through when this device owns the accounts', () => {
    expect(resolveOwnerUsageRateLimits(local, { kind: 'local' })).toBe(local)
  })

  it("shows the remote owner's Claude and Codex usage, not the viewer's", () => {
    const remote = createEmptyRateLimitState({
      claude: provider('claude', 70),
      codex: provider('codex', 80)
    })
    const resolved = resolveOwnerUsageRateLimits(local, { kind: 'remote', rateLimits: remote })
    expect(resolved.claude?.session?.usedPercent).toBe(70)
    expect(resolved.codex?.session?.usedPercent).toBe(80)
    // The viewer's Grok login is not the host's.
    expect(resolved.grok).toBeNull()
    expect(resolved.grokAuthConfigured).toBe(false)
  })

  it('treats providers and flags an older host omits as not configured there', () => {
    const {
      cursor: _cursor,
      zcode: _zcode,
      cursorAuthConfigured: _flag,
      ...older
    } = createEmptyRateLimitState({ claude: provider('claude', 5) })
    // Why: an older host's payload lacks keys the current type requires.
    const rateLimits: RateLimitState = Object.assign(Object.create(null), older)
    const resolved = resolveOwnerUsageRateLimits(local, { kind: 'remote', rateLimits })
    expect(resolved.cursor).toBeNull()
    expect(resolved.zcode).toBeNull()
    expect(resolved.cursorAuthConfigured).toBe(false)
    expect(resolved.claude?.session?.usedPercent).toBe(5)
  })

  it('never renders local percentages while the first remote snapshot is in flight', () => {
    const resolved = resolveOwnerUsageRateLimits(local, { kind: 'remote-pending' })
    for (const key of ['claude', 'codex', 'grok'] as const) {
      expect(resolved[key]?.status).toBe('fetching')
      expect(resolved[key]?.session).toBeNull()
    }
  })

  it('says usage is unavailable when an older host publishes none, without erroring', () => {
    const resolved = resolveOwnerUsageRateLimits(local, {
      kind: 'remote-unverifiable',
      ownerLabel: 'Mac Mini',
      reason: 'usage-not-published',
      lastKnown: null
    })
    const claude = resolved.claude!
    expect(claude.session).toBeNull()
    expect(getProviderUsageStatusLabel(claude)).toBe('Usage unavailable')
    expect(getProviderUsageErrorMessage(claude)).toContain('Mac Mini does not report usage')
  })

  it('keeps the bars an unreachable host vouched for, blanked, and invents none', () => {
    const lastKnown = createEmptyRateLimitState({ codex: provider('codex', 40) })
    const resolved = resolveOwnerUsageRateLimits(local, {
      kind: 'remote-unverifiable',
      ownerLabel: 'devbox',
      reason: 'unreachable',
      lastKnown
    })
    expect(resolved.codex?.session).toBeNull()
    expect(getProviderUsageStatusLabel(resolved.codex!)).toBe('Usage unavailable')
    expect(getProviderUsageErrorMessage(resolved.codex!)).toContain('cannot reach devbox')
    expect(resolved.claude).toBeNull()
    expect(resolved.grok).toBeNull()
  })

  it("never copies the viewer's setup flags into a pending or disconnected remote state", () => {
    const pending = resolveOwnerUsageRateLimits(local, { kind: 'remote-pending' })
    expect(pending.grokAuthConfigured).toBe(false)
    const lastKnown = createEmptyRateLimitState({
      codex: provider('codex', 40),
      cursorAuthConfigured: true
    })
    const lost = resolveOwnerUsageRateLimits(local, {
      kind: 'remote-unverifiable',
      ownerLabel: 'devbox',
      reason: 'unreachable',
      lastKnown
    })
    expect(lost.grokAuthConfigured).toBe(false)
    expect(lost.cursorAuthConfigured).toBe(true)
    const neverAnswered = resolveOwnerUsageRateLimits(local, {
      kind: 'remote-unverifiable',
      ownerLabel: 'devbox',
      reason: 'unreachable',
      lastKnown: null
    })
    expect(neverAnswered.grokAuthConfigured).toBe(false)
    expect(neverAnswered.grok).toBeNull()
    expect(neverAnswered.codex?.status).toBe('error')
  })

  it('stops a slot the host was still fetching from loading through an outage', () => {
    const lastKnown = createEmptyRateLimitState({
      grok: { ...provider('grok', 0), session: null, status: 'fetching' },
      grokAuthConfigured: true
    })
    const lost = resolveOwnerUsageRateLimits(local, {
      kind: 'remote-unverifiable',
      ownerLabel: 'devbox',
      reason: 'unreachable',
      lastKnown
    })
    expect(lost.grok?.status).toBe('error')
  })
})

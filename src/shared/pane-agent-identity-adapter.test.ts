import { describe, expect, it } from 'vitest'
import {
  buildPaneAgentIdentityEvidenceWire,
  isForegroundProcessProofFresh,
  resolveCanonicalPaneAgentIdentity,
  type ForegroundProcessProof
} from './pane-agent-identity-adapter'

const freshProof: ForegroundProcessProof = {
  agent: 'codex',
  processIncarnation: 'opaque-pid-token',
  authorityId: 'main:test',
  capturedAgeMs: 50,
  validForMs: 5_000
}

describe('per-pane coverage gate', () => {
  it('covers a pane from hook, launch, or sleeping-session evidence alone', () => {
    expect(
      resolveCanonicalPaneAgentIdentity({ hookAgent: 'claude', hookIsLive: true }).coverage
    ).toBe('covered')
    expect(resolveCanonicalPaneAgentIdentity({ completedHookAgent: 'claude' }).coverage).toBe(
      'covered'
    )
    expect(resolveCanonicalPaneAgentIdentity({ launchAgent: 'codex' }).coverage).toBe('covered')
    expect(resolveCanonicalPaneAgentIdentity({ sleepingSessionAgent: 'gemini' }).coverage).toBe(
      'covered'
    )
  })

  it('never covers a pane from a title, a sibling, or a bare foreground name', () => {
    expect(resolveCanonicalPaneAgentIdentity({ title: 'claude' }).coverage).toBe('uncovered')
    expect(
      resolveCanonicalPaneAgentIdentity({ siblingAgent: 'claude', allowSibling: true }).coverage
    ).toBe('uncovered')
    expect(resolveCanonicalPaneAgentIdentity({ foregroundAgent: 'codex' }).coverage).toBe(
      'uncovered'
    )
  })

  it('is computed from evidence, never from a platform or remote flag', () => {
    // The input deliberately has no platform/isRemote field to branch on; this pins that a
    // hook-covered pane resolves identically regardless of any caller-side host knowledge.
    const identity = resolveCanonicalPaneAgentIdentity({ hookAgent: 'claude', hookIsLive: true })
    expect(identity).toMatchObject({ agent: 'claude', source: 'live-hook', coverage: 'covered' })
  })
})

describe('process rung requires a host-stamped proof', () => {
  it('rejects a stale or malformed proof and accepts a fresh one', () => {
    expect(isForegroundProcessProofFresh(freshProof)).toBe(true)
    expect(isForegroundProcessProofFresh({ ...freshProof, capturedAgeMs: 6_000 })).toBe(false)
    expect(isForegroundProcessProofFresh({ ...freshProof, capturedAgeMs: -1 })).toBe(false)
    expect(isForegroundProcessProofFresh({ ...freshProof, validForMs: 0 })).toBe(false)
    expect(isForegroundProcessProofFresh({ ...freshProof, capturedAgeMs: Number.NaN })).toBe(false)
  })

  it('a bare foreground name cannot outrank launch; a proven process can', () => {
    const unproven = resolveCanonicalPaneAgentIdentity({
      launchAgent: 'claude',
      foregroundAgent: 'codex'
    })
    expect(unproven).toMatchObject({ agent: 'claude', source: 'launch' })

    const proven = resolveCanonicalPaneAgentIdentity({
      launchAgent: 'claude',
      foregroundAgent: 'codex',
      processProof: freshProof
    })
    expect(proven).toMatchObject({ agent: 'codex', source: 'process', coverage: 'covered' })
  })

  it('an expired proof and a name-mismatched proof both drop the process rung', () => {
    const expired = resolveCanonicalPaneAgentIdentity({
      launchAgent: 'claude',
      foregroundAgent: 'codex',
      processProof: { ...freshProof, capturedAgeMs: 10_000 }
    })
    expect(expired).toMatchObject({ agent: 'claude', source: 'launch' })

    const mismatched = resolveCanonicalPaneAgentIdentity({
      launchAgent: 'claude',
      foregroundAgent: 'gemini',
      processProof: freshProof
    })
    expect(mismatched).toMatchObject({ agent: 'claude', source: 'launch' })
  })
})

describe('uncovered compatibility lane', () => {
  it('preserves the caller-provided legacy result verbatim', () => {
    const identity = resolveCanonicalPaneAgentIdentity({
      title: 'Fix the parser - grok',
      uncoveredFallback: { agent: 'grok', titleOnly: true }
    })
    expect(identity).toMatchObject({
      agent: 'grok',
      source: 'title',
      coverage: 'uncovered',
      titleOnly: true
    })
  })

  it('answers from title evidence marked title-only when no fallback is supplied', () => {
    const identity = resolveCanonicalPaneAgentIdentity({
      title: 'STA-4011 Linux Antigravity Commit Messages - grok'
    })
    expect(identity).toMatchObject({
      agent: 'grok',
      source: 'title',
      coverage: 'uncovered',
      titleOnly: true
    })
  })

  it('a legacy null stays null rather than re-deriving from the title', () => {
    const identity = resolveCanonicalPaneAgentIdentity({
      title: 'anything - grok',
      uncoveredFallback: { agent: null }
    })
    expect(identity).toMatchObject({ agent: null, source: null, coverage: 'uncovered' })
  })

  it('does not let a legacy title fallback bypass the ambiguity fence', () => {
    expect(
      resolveCanonicalPaneAgentIdentity({
        title: 'OC | something - grok',
        uncoveredFallback: { agent: 'opencode', titleOnly: true }
      })
    ).toMatchObject({ agent: null, source: null, ambiguousAt: 'title' })
    expect(
      resolveCanonicalPaneAgentIdentity({
        title: 'compare codex with grok',
        uncoveredFallback: { agent: 'codex', titleOnly: true }
      })
    ).toMatchObject({ agent: null, source: null, coverage: 'uncovered' })
  })

  it('does not label a foreground-only compatibility answer as title-only', () => {
    const identity = resolveCanonicalPaneAgentIdentity({
      foregroundAgent: 'codex',
      uncoveredFallback: { agent: 'codex' }
    })
    expect(identity).toMatchObject({
      agent: 'codex',
      source: null,
      coverage: 'uncovered',
      titleOnly: false
    })
  })
})

describe('canonical ladder inside the covered lane', () => {
  it('keeps title last: a covered launch beats a parsed title', () => {
    const identity = resolveCanonicalPaneAgentIdentity({
      launchAgent: 'claude',
      title: 'STA-4011 Linux Antigravity Commit Messages - grok'
    })
    expect(identity).toMatchObject({ agent: 'claude', source: 'launch', titleOnly: false })
  })

  it('sibling evidence needs the explicit tab-scope opt-in', () => {
    const withoutOptIn = resolveCanonicalPaneAgentIdentity({
      launchAgent: 'claude',
      siblingAgent: 'codex'
    })
    expect(withoutOptIn.agent).toBe('claude')
    const optedIn = resolveCanonicalPaneAgentIdentity({
      hookAgent: 'claude',
      hookIsLive: true,
      siblingAgent: 'codex',
      allowSibling: true
    })
    expect(optedIn).toMatchObject({ agent: 'claude', source: 'live-hook' })
  })

  it('surfaces ambiguity instead of picking by array order', () => {
    const identity = resolveCanonicalPaneAgentIdentity({
      hookAgent: 'claude',
      hookIsLive: false,
      completedHookAgent: 'codex'
    })
    expect(identity).toMatchObject({ agent: null, ambiguousAt: 'completed-hook' })
  })
})

describe('reclaim-versus-stale-hook discriminator (run keys, not title text)', () => {
  const run1 = { authorityId: 'main:a', incarnation: 1 }
  const run2 = { authorityId: 'main:a', incarnation: 2 }
  const otherAuthority = { authorityId: 'renderer:b', incarnation: 9 }

  it('bug shape: hook and pane share the current run, so the completed hook wins over the title', () => {
    const identity = resolveCanonicalPaneAgentIdentity({
      completedHookAgent: 'claude',
      completedHookRun: run1,
      currentRun: run1,
      title: 'STA-4011 Linux Antigravity Commit Messages - grok'
    })
    expect(identity).toMatchObject({ agent: 'claude', source: 'completed-hook' })
  })

  it('reclaim shape: a superseded hook is ineligible and the current title evidence answers', () => {
    const identity = resolveCanonicalPaneAgentIdentity({
      completedHookAgent: 'claude',
      completedHookRun: run1,
      currentRun: run2,
      title: 'STA-4011 Linux Antigravity Commit Messages - grok'
    })
    expect(identity).toMatchObject({
      agent: 'grok',
      source: 'title',
      coverage: 'uncovered',
      titleOnly: true
    })
    expect(identity.supersededSources).toEqual(['completed-hook'])
  })

  it('cross-authority runs are incomparable, so the hook stays eligible', () => {
    const identity = resolveCanonicalPaneAgentIdentity({
      completedHookAgent: 'claude',
      completedHookRun: otherAuthority,
      currentRun: run2,
      title: 'STA-4011 Linux Antigravity Commit Messages - grok'
    })
    expect(identity).toMatchObject({ agent: 'claude', source: 'completed-hook' })
  })

  it('an absent run key keeps evidence eligible (old peer), never guessed stale', () => {
    const identity = resolveCanonicalPaneAgentIdentity({
      completedHookAgent: 'claude',
      currentRun: run2,
      title: 'STA-4011 Linux Antigravity Commit Messages - grok'
    })
    expect(identity).toMatchObject({ agent: 'claude', source: 'completed-hook' })
  })
})

describe('action floor', () => {
  it("minimumSource: 'launch' refuses title and completed-hook answers outright", () => {
    const identity = resolveCanonicalPaneAgentIdentity({
      completedHookAgent: 'claude',
      title: 'claude',
      minimumSource: 'launch'
    })
    expect(identity).toMatchObject({ agent: null, source: null, coverage: 'covered' })
  })
})

describe('wire evidence projection', () => {
  it('publishes nothing for an absent identity — absence stays absence', () => {
    expect(
      buildPaneAgentIdentityEvidenceWire(resolveCanonicalPaneAgentIdentity({}))
    ).toBeUndefined()
  })

  it('marks the uncovered title-only route explicitly and carries the run key when known', () => {
    const wire = buildPaneAgentIdentityEvidenceWire(
      resolveCanonicalPaneAgentIdentity({ title: 'claude - claude' }),
      { authorityId: 'main:a', incarnation: 3 },
      { capturedAgeMs: 10, validForMs: 1_000 }
    )
    expect(wire).toMatchObject({
      coverage: 'uncovered',
      titleOnlyActionFallback: true,
      authorityId: 'main:a',
      incarnation: 3,
      freshness: { capturedAgeMs: 10, validForMs: 1_000 }
    })
  })

  it('a covered identity never carries the title-only action marker', () => {
    const wire = buildPaneAgentIdentityEvidenceWire(
      resolveCanonicalPaneAgentIdentity({ launchAgent: 'claude' })
    )
    expect(wire).toMatchObject({ source: 'launch', coverage: 'covered' })
    expect(wire?.titleOnlyActionFallback).toBeUndefined()
  })
})

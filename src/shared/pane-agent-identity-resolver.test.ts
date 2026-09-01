import { describe, expect, it } from 'vitest'
import {
  PANE_AGENT_EVIDENCE_SOURCES,
  type PaneAgentEvidence,
  resolvePaneAgentIdentity
} from './pane-agent-identity-resolver'

const resolve = (evidence: PaneAgentEvidence[], extra = {}) =>
  resolvePaneAgentIdentity({ evidence, ...extra })

const H = 'authority-a'

describe('resolvePaneAgentIdentity', () => {
  describe('a display title is the last thing consulted', () => {
    it.each(PANE_AGENT_EVIDENCE_SOURCES.filter((s) => s !== 'title' && s !== 'sibling'))(
      'lets %s outrank a conflicting title',
      (source) => {
        const result = resolve([
          { source: 'title', agent: 'codex' },
          { source, agent: 'grok' }
        ])
        expect(result.agent).toBe('grok')
        expect(result.source).toBe(source)
      }
    )

    it('uses the title only when nothing else is eligible', () => {
      expect(resolve([{ source: 'title', agent: 'codex' }])).toMatchObject({
        agent: 'codex',
        source: 'title'
      })
    })

    it('outranks the launch record with nothing weaker than the launch record', () => {
      // The tab ladder currently puts the parsed title ABOVE activeLaunchAgent, so a string Orca
      // parsed beats a fact Orca owns. That inversion cannot be expressed here.
      const result = resolve([
        { source: 'launch', agent: 'claude' },
        { source: 'title', agent: 'gemini' }
      ])
      expect(result.agent).toBe('claude')
    })
  })

  describe('run generation separates the bug from the legitimate reclaim', () => {
    // Both shapes are `completed hook = A, title = B`. Ordering alone cannot tell them apart.
    const shape = (hookRun: number, titleRun: number): PaneAgentEvidence[] => [
      { source: 'completed-hook', agent: 'claude', run: { authorityId: H, incarnation: hookRun } },
      { source: 'title', agent: 'codex', run: { authorityId: H, incarnation: titleRun } }
    ]

    it('keeps the completed hook when both belong to the current run', () => {
      // The reported bug: nothing new started, so the hook is still the truth.
      const result = resolvePaneAgentIdentity({
        evidence: shape(7, 7),
        currentRun: { authorityId: H, incarnation: 7 }
      })
      expect(result).toMatchObject({ agent: 'claude', source: 'completed-hook' })
      expect(result.supersededSources).toEqual([])
    })

    it('drops the completed hook once a new run has started', () => {
      // The legitimate reclaim: the pane was reused, so run 7's hook describes an agent that is
      // no longer there. It is ineligible, not merely outranked.
      const result = resolvePaneAgentIdentity({
        evidence: shape(7, 8),
        currentRun: { authorityId: H, incarnation: 8 }
      })
      expect(result).toMatchObject({ agent: 'codex', source: 'title' })
      expect(result.supersededSources).toEqual(['completed-hook'])
    })

    it('produces opposite answers from identical evidence, given only the run ids', () => {
      // The whole point, stated as one assertion.
      const bug = resolvePaneAgentIdentity({
        evidence: shape(7, 7),
        currentRun: { authorityId: H, incarnation: 7 }
      })
      const reclaim = resolvePaneAgentIdentity({
        evidence: shape(7, 8),
        currentRun: { authorityId: H, incarnation: 8 }
      })
      expect(bug.agent).not.toBe(reclaim.agent)
    })
  })

  describe('mixed-version peers', () => {
    it('keeps a run-key-less completed row from hijacking launch evidence', () => {
      const result = resolve([
        { source: 'completed-hook', agent: 'claude' },
        { source: 'launch', agent: 'codex' }
      ])
      expect(result).toMatchObject({ agent: 'codex', source: 'launch' })
    })

    it('treats evidence with no run id as eligible', () => {
      // An old host publishes no run ids. Treating unknown as stale would blank every row.
      const result = resolvePaneAgentIdentity({
        evidence: [{ source: 'completed-hook', agent: 'claude' }],
        currentRun: { authorityId: H, incarnation: 9 }
      })
      expect(result.agent).toBe('claude')
    })

    it('disables run filtering entirely when the pane has no current run', () => {
      const result = resolvePaneAgentIdentity({
        evidence: [
          { source: 'completed-hook', agent: 'claude', run: { authorityId: H, incarnation: 3 } }
        ]
      })
      expect(result).toMatchObject({ agent: 'claude', supersededSources: [] })
    })
  })

  describe('siblings are tab-scoped', () => {
    it('ignores a sibling by default', () => {
      expect(resolve([{ source: 'sibling', agent: 'codex' }]).agent).toBeNull()
    })

    it('accepts a sibling when the caller opts in', () => {
      expect(resolve([{ source: 'sibling', agent: 'codex' }], { allowSibling: true }).agent).toBe(
        'codex'
      )
    })

    it('still ranks a sibling above a title', () => {
      const result = resolve(
        [
          { source: 'title', agent: 'grok' },
          { source: 'sibling', agent: 'codex' }
        ],
        { allowSibling: true }
      )
      expect(result.source).toBe('sibling')
    })
  })

  describe('no eligible evidence', () => {
    it('returns null rather than guessing', () => {
      expect(resolve([])).toMatchObject({ agent: null, source: null })
    })

    it('returns null when every source belongs to a superseded run', () => {
      const result = resolvePaneAgentIdentity({
        evidence: [
          { source: 'live-hook', agent: 'claude', run: { authorityId: H, incarnation: 1 } },
          { source: 'title', agent: 'codex', run: { authorityId: H, incarnation: 1 } }
        ],
        currentRun: { authorityId: H, incarnation: 2 }
      })
      expect(result.agent).toBeNull()
      expect(result.supersededSources).toEqual(['live-hook', 'title'])
    })
  })

  describe('input order does not decide the answer', () => {
    it('resolves the same regardless of how evidence is listed', () => {
      const evidence: PaneAgentEvidence[] = [
        { source: 'title', agent: 'codex' },
        { source: 'launch', agent: 'grok' },
        { source: 'live-hook', agent: 'claude' }
      ]
      const forward = resolve([...evidence])
      const reverse = resolve(evidence.toReversed())
      expect(forward).toEqual(reverse)
      expect(forward.source).toBe('live-hook')
    })
  })

  describe('two observations of the same class cannot be settled by array order', () => {
    // Review finding: `eligible.find(...)` returned the FIRST match, so duplicates of one source
    // naming different agents resolved by input order — the exact property this resolver exists to
    // remove. The earlier order-independence test only used DISTINCT sources, so it never saw it.
    it('returns null when two live hooks name different agents', () => {
      const result = resolve([
        { source: 'live-hook', agent: 'claude' },
        { source: 'live-hook', agent: 'codex' }
      ])
      expect(result.agent).toBeNull()
      expect(result.ambiguousAt).toBe('live-hook')
    })

    it('gives the same answer in either order', () => {
      const a: PaneAgentEvidence[] = [
        { source: 'live-hook', agent: 'claude' },
        { source: 'live-hook', agent: 'codex' }
      ]
      expect(resolve(a)).toEqual(resolve(a.toReversed()))
    })

    it('still resolves when duplicates agree', () => {
      expect(
        resolve([
          { source: 'live-hook', agent: 'claude' },
          { source: 'live-hook', agent: 'claude' }
        ]).agent
      ).toBe('claude')
    })

    it('does not fall through to a weaker source on conflict', () => {
      // Falling through would let a title answer whenever two hooks disagreed — strictly worse
      // than saying nothing.
      const result = resolve([
        { source: 'live-hook', agent: 'claude' },
        { source: 'live-hook', agent: 'codex' },
        { source: 'title', agent: 'grok' }
      ])
      expect(result.agent).toBeNull()
    })
  })

  describe('run keys from different authorities are incomparable, not stale', () => {
    // Review finding: a bare numeric runId collides across authority restarts. A restarted main
    // regenerates its authorityId and counts incarnations from its own floor, so `1 === 1` would
    // equate two unrelated runs.
    it('keeps evidence whose authority differs, even when the incarnations do not match', () => {
      // The incarnations must DIFFER for this to discriminate. With both at 1, a resolver that
      // ignored authority entirely would still pass on the numeric compare — verified by mutation,
      // which is how the first version of this test was caught as vacuous.
      const result = resolvePaneAgentIdentity({
        evidence: [
          { source: 'live-hook', agent: 'claude', run: { authorityId: 'host-b', incarnation: 5 } }
        ],
        currentRun: { authorityId: 'host-a', incarnation: 2 }
      })
      expect(result.agent).toBe('claude')
      expect(result.supersededSources).toEqual([])
    })

    it('does not equate the same incarnation number from two authorities', () => {
      // A restarted main regenerates authorityId and counts from its own floor, so `1` from
      // host-b is not `1` from host-a. Incomparable is treated as unknown, so the evidence is
      // kept rather than being read as either current or stale.
      const result = resolvePaneAgentIdentity({
        evidence: [
          { source: 'launch', agent: 'codex', run: { authorityId: 'host-b', incarnation: 1 } }
        ],
        currentRun: { authorityId: 'host-a', incarnation: 1 }
      })
      expect(result).toMatchObject({ agent: 'codex', source: 'launch' })
    })

    it('supersedes only within the same authority', () => {
      const result = resolvePaneAgentIdentity({
        evidence: [
          { source: 'live-hook', agent: 'claude', run: { authorityId: 'host-a', incarnation: 1 } }
        ],
        currentRun: { authorityId: 'host-a', incarnation: 2 }
      })
      expect(result.agent).toBeNull()
      expect(result.supersededSources).toEqual(['live-hook'])
    })
  })

  describe('an action consumer can refuse to see weak evidence at all', () => {
    // Review finding: title remained available to consumers that AUTHORIZE A WRITE. Ranking it
    // last makes misuse unlikely; dropping it makes misuse impossible.
    it('ignores a title entirely below the floor', () => {
      const result = resolve([{ source: 'title', agent: 'codex' }], { minimumSource: 'launch' })
      expect(result.agent).toBeNull()
    })

    it('ignores a sibling below the floor even when opted in', () => {
      const result = resolve([{ source: 'sibling', agent: 'codex' }], {
        allowSibling: true,
        minimumSource: 'launch'
      })
      expect(result.agent).toBeNull()
    })

    it('still answers from evidence at or above the floor', () => {
      const result = resolve(
        [
          { source: 'launch', agent: 'claude' },
          { source: 'title', agent: 'codex' }
        ],
        { minimumSource: 'launch' }
      )
      expect(result).toMatchObject({ agent: 'claude', source: 'launch' })
    })

    it('leaves display consumers unrestricted when no floor is given', () => {
      expect(resolve([{ source: 'title', agent: 'codex' }]).agent).toBe('codex')
    })
  })
})

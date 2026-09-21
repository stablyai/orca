import { describe, expect, it } from 'vitest'
import {
  AgentStatusObservationSequencer,
  createAgentStatusAuthorityId
} from './agent-status-observation'

const PANE_A = 'tab-a:11111111-1111-4111-8111-111111111111'
const PANE_B = 'tab-b:22222222-2222-4222-8222-222222222222'

function observe(
  sequencer: AgentStatusObservationSequencer,
  paneKey: string
): ReturnType<AgentStatusObservationSequencer['observe']> {
  return sequencer.observe(paneKey, { origin: 'hook', observedAt: 1_000 })
}

describe('AgentStatusObservationSequencer', () => {
  it('advances revision strictly for every observation of a pane', () => {
    const sequencer = new AgentStatusObservationSequencer('authority-1')

    const first = observe(sequencer, PANE_A)
    const second = observe(sequencer, PANE_A)
    const third = observe(sequencer, PANE_A)

    expect(first.revision).toBeLessThan(second.revision)
    expect(second.revision).toBeLessThan(third.revision)
    expect(first.authorityId).toBe('authority-1')
  })

  it('keeps each pane strictly increasing while panes interleave', () => {
    const sequencer = new AgentStatusObservationSequencer('authority-1')

    const a1 = observe(sequencer, PANE_A)
    const b1 = observe(sequencer, PANE_B)
    const a2 = observe(sequencer, PANE_A)
    const b2 = observe(sequencer, PANE_B)

    expect(a2.revision).toBeGreaterThan(a1.revision)
    expect(b2.revision).toBeGreaterThan(b1.revision)
  })

  it('bumps incarnation on rebind and leaves it alone otherwise', () => {
    const sequencer = new AgentStatusObservationSequencer('authority-1')

    const before = observe(sequencer, PANE_A)
    const stillBefore = observe(sequencer, PANE_A)
    sequencer.rebind(PANE_A)
    const after = observe(sequencer, PANE_A)

    expect(stillBefore.incarnation).toBe(before.incarnation)
    expect(after.incarnation).toBeGreaterThan(before.incarnation)
    // Why: rebind marks a new session behind the key; it must not rewind the order of what came before.
    expect(after.revision).toBeGreaterThan(stillBefore.revision)
  })

  it('rebinding one pane does not move another pane already being tracked', () => {
    const sequencer = new AgentStatusObservationSequencer('authority-1')

    const otherBefore = observe(sequencer, PANE_B)
    sequencer.rebind(PANE_A)
    const otherAfter = observe(sequencer, PANE_B)

    expect(otherAfter.incarnation).toBe(otherBefore.incarnation)
  })

  it('never lowers a pane incarnation after its state is forgotten', () => {
    const sequencer = new AgentStatusObservationSequencer('authority-1')

    observe(sequencer, PANE_A)
    sequencer.rebind(PANE_A)
    const rebound = observe(sequencer, PANE_A)
    sequencer.forget(PANE_A)
    const reobserved = observe(sequencer, PANE_A)

    expect(reobserved.incarnation).toBeGreaterThanOrEqual(rebound.incarnation)
    expect(reobserved.revision).toBeGreaterThan(rebound.revision)
  })

  it('keeps revision increasing for a pane whose per-pane state was evicted by the cap', () => {
    const sequencer = new AgentStatusObservationSequencer('authority-1')

    const first = observe(sequencer, PANE_A)
    // Why: overflow the bounded per-pane map so PANE_A's entry is definitely evicted.
    for (let i = 0; i < 2_000; i++) {
      observe(sequencer, `tab-flood:${i}`)
    }
    const afterEviction = observe(sequencer, PANE_A)

    expect(afterEviction.revision).toBeGreaterThan(first.revision)
    expect(afterEviction.incarnation).toBeGreaterThanOrEqual(first.incarnation)
  })

  it('stamps the requested facets and omits absent optional ones', () => {
    const sequencer = new AgentStatusObservationSequencer('authority-1')

    const boundary = sequencer.observe(PANE_A, {
      origin: 'osc',
      observedAt: 42,
      boundary: true,
      kind: 'snapshot'
    })
    const plain = sequencer.observe(PANE_A, { origin: 'title', observedAt: 43, boundary: false })

    expect(boundary).toMatchObject({
      origin: 'osc',
      observedAt: 42,
      boundary: true,
      kind: 'snapshot'
    })
    expect(plain.origin).toBe('title')
    expect('boundary' in plain).toBe(false)
    expect('kind' in plain).toBe(false)
  })

  it('gives each sequencer instance a distinct authority id', () => {
    // Why: revision counters live in memory, so a restarted authority must not be
    // comparable with the observations it emitted before.
    const first = createAgentStatusAuthorityId('main-agent-hooks')
    const second = createAgentStatusAuthorityId('main-agent-hooks')

    expect(first).not.toBe(second)
    expect(first.startsWith('main-agent-hooks:')).toBe(true)
  })
})

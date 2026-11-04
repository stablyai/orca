import { describe, expect, it } from 'vitest'
import { AgentStatusObservationSequencer } from './agent-status-observation'

const PANE_A = 'tab-a:11111111-1111-4111-8111-111111111111'

function observe(
  sequencer: AgentStatusObservationSequencer,
  paneKey: string
): ReturnType<AgentStatusObservationSequencer['observe']> {
  return sequencer.observe(paneKey, { origin: 'hook', observedAt: 1_000 })
}

describe('AgentStatusObservationSequencer', () => {
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
})

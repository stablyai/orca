// #9819. Every case here is the same question asked from a different angle: can this client PROVE
// the host is holding a process nobody can reach? A "no" has to mean "leave it running".
import { describe, expect, it } from 'vitest'
import type { ForegroundProcessEvidence } from './foreground-process-evidence'
import {
  planRelayPtySweep,
  RELAY_PTY_SWEEP_MAX_EVIDENCE_AGE_MS,
  RELAY_PTY_SWEEP_MAX_PER_PASS,
  RELAY_PTY_SWEEP_MIN_AGE_MS,
  type RelayPtyOwnershipEvidence,
  type RelayPtySweepContext
} from './ssh-relay-pty-ownership-proof'

const OURS = 'client-instance-ours'

const OBSERVATION = { authorityGeneration: 'gen-1', observationEpoch: 1, capturedAgeMs: 0 }

/** The host looked at the pane and saw its own shell owning the terminal: nothing is running. */
function idleShell(): ForegroundProcessEvidence {
  return { ...OBSERVATION, verdict: 'live', processName: null, shellOwnsEveryTtyProcessGroup: true }
}

function orphan(overrides: Partial<RelayPtyOwnershipEvidence> = {}): RelayPtyOwnershipEvidence {
  return {
    ptyId: 'pty-1',
    incarnationId: 'inc-1',
    ownerClientInstanceId: OURS,
    hostAgeMs: RELAY_PTY_SWEEP_MIN_AGE_MS * 2,
    paneBound: true,
    foregroundProcessEvidence: idleShell(),
    ...overrides
  }
}

function context(overrides: Partial<RelayPtySweepContext> = {}): RelayPtySweepContext {
  return {
    clientInstanceId: OURS,
    isSessionOwner: true,
    routedPtyIds: new Set<string>(),
    expiredLeasePtyIds: new Set<string>(),
    minimumHostAgeMs: RELAY_PTY_SWEEP_MIN_AGE_MS,
    evidenceAgeSinceListingMs: 0,
    maximumEvidenceAgeMs: RELAY_PTY_SWEEP_MAX_EVIDENCE_AGE_MS,
    ...overrides
  }
}

function reasonFor(plan: ReturnType<typeof planRelayPtySweep>, ptyId: string): string | undefined {
  return plan.skipped.find((entry) => entry.ptyId === ptyId)?.reason
}

describe('planRelayPtySweep', () => {
  it('sweeps a pane PTY this host attests we created and we have lost every route to', () => {
    const plan = planRelayPtySweep([orphan()], context())

    expect(plan.sweep).toEqual([{ ptyId: 'pty-1', incarnationId: 'inc-1' }])
  })

  it('never sweeps a PTY this client still routes to', () => {
    const plan = planRelayPtySweep([orphan()], context({ routedPtyIds: new Set(['pty-1']) }))

    expect(plan.sweep).toEqual([])
    expect(reasonFor(plan, 'pty-1')).toBe('this client still has a route to it')
  })

  it('never sweeps a PTY whose lease this client expired without ordering a stop', () => {
    // `expired` is what supersedeSiblingLeasesForPane, a reattach that failed on the transport, and
    // a pane whose surface left the layout all write, and every one of them deliberately leaves the
    // remote process running. Losing our handle is `unverifiable`; it is not abandonment.
    const plan = planRelayPtySweep([orphan()], context({ expiredLeasePtyIds: new Set(['pty-1']) }))

    expect(plan.sweep).toEqual([])
    expect(reasonFor(plan, 'pty-1')).toBe('this client expired its lease without ordering a stop')
  })

  it('never sweeps a pane the host observes running a named foreground process', () => {
    // The hand-launched agent: the user typed `claude` in a pane, so Orca registered no agent
    // session and agentSessionOwners is empty. Only the host's own observation can see it.
    const plan = planRelayPtySweep(
      [
        orphan({
          foregroundProcessEvidence: {
            ...OBSERVATION,
            verdict: 'live',
            processName: 'claude',
            shellOwnsEveryTtyProcessGroup: false
          }
        })
      ],
      context()
    )

    expect(plan.sweep).toEqual([])
    expect(reasonFor(plan, 'pty-1')).toBe('host observes a named foreground process')
  })

  it('never sweeps a pane whose foreground group is not the shell, even unnamed', () => {
    // A build, a test run, an editor: nothing recognizes it, but the host can still see that the
    // terminal's foreground process group is not the shell's own.
    const plan = planRelayPtySweep(
      [
        orphan({
          foregroundProcessEvidence: {
            ...OBSERVATION,
            verdict: 'live',
            processName: null,
            shellOwnsEveryTtyProcessGroup: false
          }
        })
      ],
      context()
    )

    expect(plan.sweep).toEqual([])
    expect(reasonFor(plan, 'pty-1')).toBe('host does not attest an idle shell')
  })

  it('never sweeps when the host could not observe the pane at all', () => {
    const plan = planRelayPtySweep(
      [
        orphan({
          foregroundProcessEvidence: {
            ...OBSERVATION,
            verdict: 'unverifiable',
            reason: 'table_unreadable'
          }
        })
      ],
      context()
    )

    expect(plan.sweep).toEqual([])
    expect(reasonFor(plan, 'pty-1')).toBe('host could not observe the pane foreground process')
  })

  it('never sweeps a PTY the host attributes to another client instance', () => {
    // The case that makes local absence useless as evidence: a second machine on the same build
    // connects to the same relay, and its live agents are missing from our store exactly like an
    // orphan is.
    const plan = planRelayPtySweep(
      [orphan({ ownerClientInstanceId: 'client-instance-theirs' })],
      context()
    )

    expect(plan.sweep).toEqual([])
    expect(reasonFor(plan, 'pty-1')).toBe('host attests another client created it')
  })

  it('never sweeps a PTY younger than the floor', () => {
    const plan = planRelayPtySweep(
      [orphan({ hostAgeMs: RELAY_PTY_SWEEP_MIN_AGE_MS - 1 })],
      context()
    )

    expect(plan.sweep).toEqual([])
    expect(reasonFor(plan, 'pty-1')).toBe('younger than the sweep floor')
  })

  it('never sweeps a bare host shell', () => {
    const plan = planRelayPtySweep([orphan({ paneBound: false })], context())

    expect(plan.sweep).toEqual([])
    expect(reasonFor(plan, 'pty-1')).toBe('not a pane-bound PTY')
  })

  it('never sweeps a PTY whose agent session the host still advertises as adoptable', () => {
    const plan = planRelayPtySweep(
      [orphan({ agentSessionOwners: [{ ptyId: 'pty-1' }] })],
      context()
    )

    expect(plan.sweep).toEqual([])
    expect(reasonFor(plan, 'pty-1')).toBe('host still advertises an adoptable agent session')
  })

  it('never sweeps without the negotiated session-owner grant', () => {
    const plan = planRelayPtySweep([orphan()], context({ isSessionOwner: false }))

    expect(plan.sweep).toEqual([])
    expect(reasonFor(plan, 'pty-1')).toBe('this client does not hold the relay session-owner grant')
  })

  it('refuses a pass larger than the per-pass ceiling instead of truncating it', () => {
    const entries = Array.from({ length: RELAY_PTY_SWEEP_MAX_PER_PASS + 1 }, (_, index) =>
      orphan({ ptyId: `pty-${index}`, incarnationId: `inc-${index}` })
    )

    const plan = planRelayPtySweep(entries, context())

    expect(plan.sweep).toEqual([])
    expect(plan.skipped).toHaveLength(entries.length)
  })

  describe('against a host that predates the attestation', () => {
    // Mixed versions: every new field is optional, and an older host publishes none of them. The
    // sweep has to read each absence as "unknown", never as a permissive default.
    it('skips an entry with no owner attestation', () => {
      const { ownerClientInstanceId: _absent, ...legacy } = orphan()

      const plan = planRelayPtySweep([legacy], context())

      expect(plan.sweep).toEqual([])
      expect(reasonFor(plan, 'pty-1')).toBe('host attested no owning client')
    })

    it('skips an entry with no published age', () => {
      const { hostAgeMs: _absent, ...legacy } = orphan()

      const plan = planRelayPtySweep([legacy], context())

      expect(plan.sweep).toEqual([])
      expect(reasonFor(plan, 'pty-1')).toBe('host published no age')
    })

    it('skips an entry with no paneBound field', () => {
      const { paneBound: _absent, ...legacy } = orphan()

      const plan = planRelayPtySweep([legacy], context())

      expect(plan.sweep).toEqual([])
      expect(reasonFor(plan, 'pty-1')).toBe('not a pane-bound PTY')
    })

    it('skips an entry with no foreground observation', () => {
      const { foregroundProcessEvidence: _absent, ...legacy } = orphan()

      const plan = planRelayPtySweep([legacy], context())

      expect(plan.sweep).toEqual([])
      expect(reasonFor(plan, 'pty-1')).toBe('host published no foreground-process observation')
    })

    it('skips an entry from a host that observes the pane but cannot say the shell is idle', () => {
      const plan = planRelayPtySweep(
        [
          orphan({
            foregroundProcessEvidence: { ...OBSERVATION, verdict: 'live', processName: null }
          })
        ],
        context()
      )

      expect(plan.sweep).toEqual([])
      expect(reasonFor(plan, 'pty-1')).toBe('host does not attest an idle shell')
    })

    it('skips an entry with no incarnation, so no stop is ever unfenced', () => {
      const { incarnationId: _absent, ...legacy } = orphan()

      const plan = planRelayPtySweep([legacy], context())

      expect(plan.sweep).toEqual([])
      expect(reasonFor(plan, 'pty-1')).toBe('host published no PTY incarnation')
    })

    it('sweeps nothing at all when the whole listing predates the fields', () => {
      const legacy = [
        { ptyId: 'pty-1', incarnationId: 'inc-1' },
        { ptyId: 'pty-2', incarnationId: 'inc-2' }
      ]

      expect(planRelayPtySweep(legacy, context()).sweep).toEqual([])
    })
  })
})

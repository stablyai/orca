import { beforeAll, describe, expect, it } from 'vitest'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

/**
 * The session-tabs retirement-proof surface, paired across two builds.
 *
 * `cross-version-terminal-wire` covers the terminal binary stream and
 * `cross-version-agent-session-wire` covers `agentSession.*`; neither reaches the
 * session-tabs frame, which is where a paired client learns that a mirrored terminal
 * is gone. This pairs the two halves of that surface across versions:
 *
 *  - the HOST half changed — a host now ships a retirement proof on its own frame when
 *    no surface removal carries one (`attachRetirementProofsToSnapshot`);
 *  - the CLIENT half did not change, which this asserts by running both builds' ledger
 *    over the same frames rather than by reading the diff.
 *
 * The claim under test is the one written into the change: that this is Rule 1, because
 * `retiredTerminalSurfaces` is an existing optional field on an existing path. Rule 3's
 * fourth bullet says "a frame the host ... starts sending, on an existing path" is a wire
 * change even with no codec movement, so the claim is checked against an actual old
 * build rather than accepted.
 *
 * The pre-stack ref is pinned rather than derived: this contract needs a release from
 * before the proof-only frame existed, which is the fallback
 * docs/reference/remote-wire-compatibility.md sanctions for exactly this case.
 */
const PRE_STACK_REF = 'v1.4.199'

const SUITE_TIMEOUT_MS = 180_000

const WORKTREE_ID = 'repo::/worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PARENT_TAB_ID = 'tab'
const PTY_ID = 'pty-left'
const TERMINAL_HANDLE = 'remote:terminal-handle-1'

type Snapshot = {
  worktree: string
  publicationEpoch: string
  snapshotVersion: number
  activeGroupId: null
  activeTabId: string | null
  activeTabType: string | null
  tabs: Record<string, unknown>[]
  retiredTerminalSurfaces?: Record<string, unknown>[]
}

type ProofLedger = {
  appendRetiredTerminalSurfaceProofs: (
    existing: readonly Record<string, unknown>[] | undefined,
    retired: readonly Record<string, unknown>[]
  ) => Record<string, unknown>[]
  dropRetirementProofsForLiveSurfaces: (
    retired: readonly Record<string, unknown>[],
    tabs: readonly Record<string, unknown>[]
  ) => Record<string, unknown>[]
}

type HostProofPublisher = {
  attachRetirementProofsToSnapshot?: (
    snapshot: Snapshot,
    proofs: readonly Record<string, unknown>[]
  ) => Snapshot | null
  retireTerminalSurfacesFromSnapshot: (
    args: Record<string, unknown>
  ) => { snapshot: Snapshot } | null
}

type Build = {
  label: string
  ledger: ProofLedger
  host: HostProofPublisher
}

/** The surface as the host still holds it, before the close's two halves land. */
function liveSnapshot(): Snapshot {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'renderer',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: `tab::${LEAF_ID}`,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `tab::${LEAF_ID}`,
        parentTabId: PARENT_TAB_ID,
        leafId: LEAF_ID,
        ptyId: PTY_ID,
        title: 'Left',
        isActive: true
      }
    ]
  }
}

/**
 * The renderer-first ordering, which is the one users hit: the close transaction already
 * de-persisted the surface and republished without it, so the PTY exit that follows finds
 * nothing left for persistence to accept.
 */
function snapshotAfterRendererRepublished(): Snapshot {
  return { ...liveSnapshot(), snapshotVersion: 2, tabs: [], activeTabId: null, activeTabType: null }
}

function exitProof(): Record<string, unknown> {
  return {
    parentTabId: PARENT_TAB_ID,
    leafId: LEAF_ID,
    ptyId: PTY_ID,
    terminal: TERMINAL_HANDLE,
    incarnationId: 'inc-1'
  }
}

async function loadBuild(ref: string | null): Promise<Build> {
  if (ref === null) {
    const [ledger, proof, retirement] = await Promise.all([
      import('../../../src/shared/terminal-retirement-proof-ledger'),
      import('../../../src/main/runtime/mobile-session-terminal-retirement-proof'),
      import('../../../src/main/runtime/mobile-session-terminal-retirement')
    ])
    return {
      label: 'stack',
      ledger: ledger as unknown as ProofLedger,
      host: { ...proof, ...retirement } as unknown as HostProofPublisher
    }
  }
  const checkout = await materializeReleaseCheckout(ref)
  const [ledger, proof, retirement] = await Promise.all([
    importReleaseCheckoutModule(checkout, 'src/shared/terminal-retirement-proof-ledger.ts'),
    importReleaseCheckoutModule(
      checkout,
      'src/main/runtime/mobile-session-terminal-retirement-proof.ts'
    ),
    importReleaseCheckoutModule(checkout, 'src/main/runtime/mobile-session-terminal-retirement.ts')
  ])
  return {
    label: ref,
    ledger: ledger as unknown as ProofLedger,
    host: { ...proof, ...retirement } as unknown as HostProofPublisher
  }
}

/**
 * What a host of this build publishes when the PTY exit lands after the renderer already
 * dropped the surface. `null` means it publishes nothing, which is the stuck-pane defect.
 */
function hostPublishesOnExit(build: Build, snapshot: Snapshot): Snapshot | null {
  const attach = build.host.attachRetirementProofsToSnapshot
  if (typeof attach !== 'function') {
    // Derived, not written down: this build's only route to a proof is the removal helper,
    // and with nothing left to remove it declines to produce a frame.
    return (
      build.host.retireTerminalSurfacesFromSnapshot({
        snapshot,
        ptyId: PTY_ID,
        exactSurfaces: [],
        exactOnly: true,
        retirementProofs: [exitProof()]
      })?.snapshot ?? null
    )
  }
  return attach(snapshot, [exitProof()])
}

/** What this build's client retains after the host frame, i.e. the evidence it can act on. */
function clientRetains(build: Build, frame: Snapshot | null): Record<string, unknown>[] {
  if (frame === null) {
    return []
  }
  return build.ledger.dropRetirementProofsForLiveSurfaces(
    build.ledger.appendRetiredTerminalSurfaceProofs(undefined, frame.retiredTerminalSurfaces ?? []),
    frame.tabs
  )
}

let preStack: Build
let stack: Build

beforeAll(async () => {
  ;[preStack, stack] = await Promise.all([loadBuild(PRE_STACK_REF), loadBuild(null)])
}, SUITE_TIMEOUT_MS)

describe('cross-version session-tabs retirement proof', () => {
  it('pairs the stack against a real pre-stack release', () => {
    expect(preStack.label).toBe(PRE_STACK_REF)
    expect(typeof preStack.ledger.dropRetirementProofsForLiveSurfaces).toBe('function')
    expect(typeof stack.ledger.dropRetirementProofsForLiveSurfaces).toBe('function')
    // The anti-vacuous-pass oracle. Two builds that resolved to one module would make every
    // pairing below a same-version run wearing a skew label, and all of them would pass.
    expect(preStack.ledger).not.toBe(stack.ledger)
    expect(preStack.ledger.dropRetirementProofsForLiveSurfaces).not.toBe(
      stack.ledger.dropRetirementProofsForLiveSurfaces
    )
    // Load-bearing for reading the old-host cells: they mean "this release cannot publish a
    // proof-only frame", not "the helper happened to decline". Safe to state against a pinned
    // legacy ref, which is what PRE_STACK_REF is.
    expect(preStack.host.attachRetirementProofsToSnapshot).toBeUndefined()
    expect(typeof stack.host.attachRetirementProofsToSnapshot).toBe('function')
  })

  it('old host against old client publishes no proof on the renderer-first close (the defect)', () => {
    const frame = hostPublishesOnExit(preStack, snapshotAfterRendererRepublished())
    expect(frame).toBeNull()
    expect(clientRetains(preStack, frame)).toEqual([])
  })

  it('new host against new client publishes a proof the client retains (the fix)', () => {
    const frame = hostPublishesOnExit(stack, snapshotAfterRendererRepublished())
    expect(frame).not.toBeNull()
    expect(clientRetains(stack, frame)).toEqual([exitProof()])
  })

  it('new host against OLD client: the old client acts on the proof-only frame', () => {
    const frame = hostPublishesOnExit(stack, snapshotAfterRendererRepublished())
    expect(frame).not.toBeNull()
    // The claim under test. An old client that cannot act on this frame would leave the
    // dead pane in its tab bar exactly as before the fix.
    expect(clientRetains(preStack, frame)).toEqual([exitProof()])
  })

  it('new host bumps snapshotVersion so a version-gating old client accepts the frame', () => {
    const before = snapshotAfterRendererRepublished()
    const frame = hostPublishesOnExit(stack, before)
    // A client that drops a frame whose version did not advance would silently ignore the
    // proof; this is what makes the proof-only frame reachable at all.
    expect(frame?.snapshotVersion).toBeGreaterThan(before.snapshotVersion)
  })

  it('old host against NEW client degrades to the two-inventory route, with no crash', () => {
    const frame = hostPublishesOnExit(preStack, snapshotAfterRendererRepublished())
    expect(frame).toBeNull()
    expect(clientRetains(stack, frame)).toEqual([])
  })

  it('both builds drop a proof whose surface is published live again, identically', () => {
    const stillLive = liveSnapshot()
    const proofs = [exitProof()]
    // Rule 3 hazard: a proof naming a surface the host is still publishing must not retire
    // it. Both builds must agree, or a skewed pairing retires a live pane.
    expect(preStack.ledger.dropRetirementProofsForLiveSurfaces(proofs, stillLive.tabs)).toEqual([])
    expect(stack.ledger.dropRetirementProofsForLiveSurfaces(proofs, stillLive.tabs)).toEqual([])
  })

  it('re-delivering the same exit does not fan out a second frame', () => {
    const first = hostPublishesOnExit(stack, snapshotAfterRendererRepublished())
    expect(first).not.toBeNull()
    // A version bump carrying nothing new would wake every paired client for no reason.
    expect(hostPublishesOnExit(stack, first as Snapshot)).toBeNull()
  })
})

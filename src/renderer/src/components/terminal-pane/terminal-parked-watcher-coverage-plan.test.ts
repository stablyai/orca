import { describe, expect, it } from 'vitest'
import { createTerminalParkedWatcherCoveragePlan } from './terminal-parked-watcher-coverage-plan'

const WORKTREE_ID = 'repo::/worktree'
const TAB_ID = 'tab-1'
const FIRST_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const FIRST_PTY_ID = `${WORKTREE_ID}@@session-1`
const SECOND_PTY_ID = `${WORKTREE_ID}@@session-2`

function createPlan(args?: {
  panes?: readonly { leafId: string; ptyId: string | null }[]
  generation?: number
  capability?: 'pending' | 'authoritative' | 'unavailable'
  sshParkingEnabled?: boolean
  pairedEnvironments?: readonly string[]
}) {
  return createTerminalParkedWatcherCoveragePlan({
    worktreeId: WORKTREE_ID,
    tab: { id: TAB_ID, ptyId: FIRST_PTY_ID, generation: args?.generation ?? 1 },
    panes: args?.panes ?? [{ leafId: FIRST_LEAF_ID, ptyId: FIRST_PTY_ID }],
    restorePolicy: {
      sshParkingEnabled: args?.sshParkingEnabled ?? true,
      pairedRuntimeParkingEnvironmentIds: new Set(args?.pairedEnvironments ?? [])
    },
    providerSnapshotCapability: () => args?.capability ?? 'authoritative'
  })
}

describe('terminal parked watcher coverage plan', () => {
  it('ignores pane order and mount-only pane metadata', () => {
    const mountedPanes = [
      {
        leafId: FIRST_LEAF_ID,
        ptyId: FIRST_PTY_ID,
        paneId: 1,
        drivesTabTitle: true
      },
      {
        leafId: SECOND_LEAF_ID,
        ptyId: SECOND_PTY_ID,
        paneId: 2,
        drivesTabTitle: false
      }
    ]
    const recapturedPanes = [
      { ...mountedPanes[1], paneId: 9, drivesTabTitle: true },
      { ...mountedPanes[0], paneId: 8, drivesTabTitle: false }
    ]

    expect(createPlan({ panes: mountedPanes }).materialKey).toBe(
      createPlan({ panes: recapturedPanes }).materialKey
    )
  })

  it('includes generation and exact leaf-to-PTY topology', () => {
    const panes = [
      { leafId: FIRST_LEAF_ID, ptyId: FIRST_PTY_ID },
      { leafId: SECOND_LEAF_ID, ptyId: SECOND_PTY_ID }
    ]
    const original = createPlan({ panes })
    const reminted = createPlan({ panes, generation: 2 })
    const swapped = createPlan({
      panes: [
        { leafId: FIRST_LEAF_ID, ptyId: SECOND_PTY_ID },
        { leafId: SECOND_LEAF_ID, ptyId: FIRST_PTY_ID }
      ]
    })

    expect(reminted.materialKey).not.toBe(original.materialKey)
    expect(swapped.materialKey).not.toBe(original.materialKey)
  })

  it('distinguishes pending, unsupported, and authoritative local providers', () => {
    const pending = createPlan({ capability: 'pending' })
    const blocked = createPlan({ capability: 'unavailable' })
    const covered = createPlan({ capability: 'authoritative' })

    expect(pending).toMatchObject({
      status: 'pending',
      issue: { reason: 'provider-capability-pending' }
    })
    expect(blocked).toMatchObject({
      status: 'blocked',
      issue: { reason: 'provider-snapshot-unavailable' }
    })
    expect(covered.status).toBe('covered')
    expect(new Set([pending.materialKey, blocked.materialKey, covered.materialKey]).size).toBe(3)
  })

  it('keeps missing models pending and malformed topology blocked', () => {
    expect(createPlan({ panes: [] })).toMatchObject({
      status: 'pending',
      issue: { reason: 'pane-model-pending' }
    })
    expect(createPlan({ panes: [{ leafId: FIRST_LEAF_ID, ptyId: null }] })).toMatchObject({
      status: 'pending',
      issue: { reason: 'pane-pty-pending' }
    })
    expect(createPlan({ panes: [{ leafId: 'legacy-leaf', ptyId: FIRST_PTY_ID }] })).toMatchObject({
      status: 'blocked',
      issue: { reason: 'invalid-leaf-id' }
    })
  })

  it('keys SSH and paired-runtime coverage to their exact authority', () => {
    const sshPanes = [{ leafId: FIRST_LEAF_ID, ptyId: 'ssh:connection-1@@pty-1' }]
    const pairedPanes = [{ leafId: FIRST_LEAF_ID, ptyId: 'remote:env-1@@terminal-1' }]

    expect(createPlan({ panes: sshPanes, sshParkingEnabled: false }).status).toBe('blocked')
    expect(createPlan({ panes: sshPanes, sshParkingEnabled: true }).status).toBe('covered')
    expect(createPlan({ panes: pairedPanes }).status).toBe('blocked')
    expect(createPlan({ panes: pairedPanes, pairedEnvironments: ['env-1'] }).status).toBe('covered')
  })
})

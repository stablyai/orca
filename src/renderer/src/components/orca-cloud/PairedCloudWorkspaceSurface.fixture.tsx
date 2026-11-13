// SLEEP-IN-PROGRESS (2/2): the layer over a PAIRED cloud workspace's panes (waking, asleep with its
// sealed copy, saving that copy after Sleep, and a wake the plan refused).
import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { CloudWakeProgressEvent } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import type { ReadSnapshot } from '../../../../shared/cloud-workspaces/read-snapshot'
import type { CloudReadSnapshotState } from '../../../../shared/cloud-workspaces/read-snapshot-state'
import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { markSleepCopySaving, resetWorktreeSleepViewForTests } from '@/lib/worktree-sleep-view'
import { recordBillingStatus } from '../billing/billing-summary-store'
import { sampleTeam } from '../billing/plan-billing-fixtures'
import { PairedCloudWorkspaceSurface } from './PairedCloudWorkspaceSurface'

const ID = 'paired-fixture::/workspace/orca-sandbox-checkout-retries'
const MIN = 60_000

const copy = (now: number): ReadSnapshot => ({
  v: 1,
  workspaceId: 'sbx_paired_fixture',
  snapshotId: 'snap_paired',
  capturedAt: now - 42 * MIN,
  reason: 'sleep',
  pr: null,
  sessions: [],
  git: {
    branch: 'checkout-retries',
    head: '3f95655684912ab',
    changeCount: 2,
    added: 96,
    removed: 21,
    changes: [
      {
        path: 'src/payments/webhooks.ts',
        status: 'modified',
        area: 'unstaged',
        added: 88,
        removed: 19
      },
      { path: 'src/payments/retry.ts', status: 'added', area: 'untracked', added: 8, removed: 2 }
    ],
    commits: [
      {
        id: '3f95655684912ab',
        subject: 'Retry checkout webhooks',
        author: null,
        at: now - 50 * MIN
      }
    ]
  }
})

const asleep = {
  state: 'sleeping' as const,
  metrics: null,
  uptimeMs: 0,
  usage: { totalMs: 0, centsPerHour: 75, costCents: 0 },
  archive: null,
  checkedAt: 1
}

function serve(read: (now: number) => CloudReadSnapshotState, wake?: CloudWakeProgressEvent): void {
  const now = Date.now()
  Object.defineProperty(window.api, 'cloudWorkspaces', {
    configurable: true,
    value: {
      ...window.api.cloudWorkspaces,
      readSnapshot: async () => ({ ok: true, value: read(now) }),
      localWorkspaces: async () => [],
      environmentBindings: async () => ({ sbx_paired_fixture: { environmentId: 'env-paired' } })
    }
  })
  resetWorktreeSleepViewForTests()
  seedCloudWorkspaceSnapshot({
    paired: { [ID]: 'env-paired' },
    status: { [ID]: { status: asleep, loading: false, error: null, fetchedAt: now } },
    wake: wake ? { [ID]: wake } : {},
    idsLoaded: true
  })
}

const wakeEvent = (over: Partial<CloudWakeProgressEvent> = {}): CloudWakeProgressEvent => ({
  workspaceId: ID,
  phase: 'waking',
  source: 'open',
  startedAt: Date.now() - 3_200,
  at: Date.now(),
  ...over
})

function Pane(): React.JSX.Element {
  return (
    <div className="relative h-[520px] overflow-hidden rounded-md border border-border bg-background">
      <div className="absolute inset-0 px-4 py-3 font-mono text-xs text-muted-foreground">
        Reconnecting… retrying automatically
      </div>
      <PairedCloudWorkspaceSurface workspaceId={ID} />
    </div>
  )
}

/** Opening a sleeping paired workspace: the same waking overlay an owned one shows. */
export const pairedWaking = defineFixture({
  width: 720,
  setup: () => serve(() => ({ state: 'no_snapshot' }), wakeEvent()),
  render: () => <Pane />
})

/** Asleep: the sealed copy the control plane holds, read-only, with Wake to continue. */
export const pairedAsleepWithCopy = defineFixture({
  width: 720,
  setup: () => serve((now) => ({ state: 'ready', snapshot: copy(now), storedAt: now })),
  render: () => <Pane />
})

/** Sleep just pressed here: saving its sealed copy, never "Nothing saved yet" meanwhile. */
export const pairedSaving = defineFixture({
  width: 720,
  setup: () => {
    serve(() => ({ state: 'no_snapshot' }))
    markSleepCopySaving(ID)
  },
  render: () => <Pane />
})

/** The plan refused the wake: the shared card carries the billing copy, as for an owned row. */
export const pairedWakeRefusedBilling = defineFixture({
  width: 720,
  setup: () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture entitlement overrides only the role the card reads.
    const result = { status: 'ok', entitlement: { ...sampleTeam, canManageBilling: true } } as never
    window.api.orcaProfiles.billingStatus = () => Promise.resolve(result)
    recordBillingStatus(result)
    serve(
      () => ({ state: 'no_snapshot' }),
      wakeEvent({
        phase: 'failed',
        message: 'entitlement_denied',
        billingDenial: { reason: 'included_hours_exhausted' }
      })
    )
  },
  render: () => <Pane />
})

import { defineFixture } from '../../component-fixtures/component-fixture'
import { seedCloudSyncView } from '@/lib/orca-cloud/cloud-sync-store'
import type { CloudStatusEntry } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import type { CloudDotState } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import {
  ORCA_CLOUD_SANDBOX_SPEC,
  type HostedWorkspaceStatus
} from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import type { CloudSyncView } from '../../../../shared/cloud-sync/cloud-sync-contract'
import { CloudWorkspaceStatusPanel } from './CloudWorkspaceStatusPanel'

const noop = (): void => {}
const actions = { onWake: noop, onRestart: noop, onArchive: noop, onUnarchive: noop, onSleep: noop }

const running: HostedWorkspaceStatus = {
  state: 'ready',
  metrics: {
    cpuPercent: 37,
    cpus: ORCA_CLOUD_SANDBOX_SPEC.vcpus,
    load1: 1.2,
    memTotalBytes: ORCA_CLOUD_SANDBOX_SPEC.memoryGb * 1e9,
    memUsedBytes: 5.1e9,
    diskTotalBytes: 34.3e9,
    diskUsedBytes: 6.2e9,
    uptimeSeconds: 7_420,
    oomKills: 0,
    lastOomVictim: null,
    orcadAlive: true
  },
  uptimeMs: 2 * 3_600_000 + 3 * 60_000,
  usage: { totalMs: 14.6 * 3_600_000, centsPerHour: 100, costCents: 1460 },
  archive: null,
  checkedAt: Date.now()
}
const asleep: HostedWorkspaceStatus = {
  ...running,
  state: 'sleeping',
  metrics: null,
  uptimeMs: null
}

const entry = (status: HostedWorkspaceStatus): CloudStatusEntry => ({
  status,
  loading: false,
  error: null,
  fetchedAt: Date.now() - 20_000
})

const FOLDER = '/Users/me/orca/cloud/Hello-World/fix-login-redirect'

function view(id: string, over: Partial<CloudSyncView>): CloudSyncView {
  const choice = over.choice ?? { context: true, mirror: false }
  const openPath = choice.mirror ? FOLDER : `${FOLDER}/.context`
  return {
    workspaceId: id,
    choice,
    folder: FOLDER,
    phase: 'synced',
    files: 12,
    bytes: 640_000,
    progress: null,
    lastSyncedAt: Date.now() - 8_000,
    editedHere: 0,
    skippedLarge: 0,
    overLimit: 0,
    limits: choice.mirror
      ? { maxBytes: 2_000_000_000, maxFileBytes: 100_000_000 }
      : { maxBytes: 250_000_000, maxFileBytes: 50_000_000 },
    error: null,
    openPath,
    displayPath: openPath.replace('/Users/me', '~'),
    ...over
  }
}

function panel(
  id: string,
  sync: Partial<CloudSyncView>,
  state: CloudDotState = 'running'
): ReturnType<typeof defineFixture> {
  // Seeded once, outside render: the section reads it through the same store as the live app.
  seedCloudSyncView(view(id, sync))
  return defineFixture({
    width: 300,
    render: () => {
      return (
        <div className="rounded-md border border-border bg-floating-surface p-3">
          <CloudWorkspaceStatusPanel
            workspaceId={id}
            state={state}
            entry={entry(state === 'sleeping' ? asleep : running)}
            pending={undefined}
            actions={actions}
            initialLayer="onComputer"
          />
        </div>
      )
    }
  })
}

/** Default: `.context` on, mirror off. */
export const contextSynced = panel('fx-context', {})
export const contextSyncing = panel('fx-context-start', {
  phase: 'starting',
  files: 0,
  bytes: 0,
  lastSyncedAt: null
})
export const mirrorCopying = panel('fx-mirror-copying', {
  choice: { context: true, mirror: true },
  phase: 'copying',
  progress: { done: 120, total: 1_204 }
})
export const mirrorSynced = panel('fx-mirror', {
  choice: { context: true, mirror: true },
  files: 1_204,
  bytes: 38_400_000,
  lastSyncedAt: Date.now() - 2 * 60_000
})
export const asleepWaiting = panel(
  'fx-asleep',
  {
    choice: { context: true, mirror: true },
    phase: 'waiting',
    files: 1_204,
    bytes: 38_400_000,
    lastSyncedAt: Date.now() - 63 * 60_000
  },
  'sleeping'
)
export const editedHere = panel('fx-edited', {
  choice: { context: true, mirror: true },
  files: 1_204,
  bytes: 38_400_000,
  editedHere: 3
})
export const overLimit = panel('fx-limit', {
  choice: { context: true, mirror: true },
  files: 61_000,
  bytes: 1_990_000_000,
  overLimit: 812,
  skippedLarge: 2
})
export const syncError = panel('fx-error', {
  phase: 'error',
  error: 'worktree_not_found'
})
export const bothOff = panel('fx-off', {
  choice: { context: false, mirror: false },
  phase: 'off',
  files: 0,
  bytes: 0,
  lastSyncedAt: null
})

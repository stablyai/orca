import { defineFixture } from '../../component-fixtures/component-fixture'
import { seedCloudSyncView } from '@/lib/orca-cloud/cloud-sync-store'
import type { CloudStatusEntry } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import type { CloudDotState } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import {
  ORCA_CLOUD_SANDBOX_SPEC,
  type HostedWorkspaceStatus
} from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import type { CloudSyncView } from '../../../../shared/cloud-sync/cloud-sync-contract'
import { CloudWorkspaceStatusPanel, type CloudCardLayer } from './CloudWorkspaceStatusPanel'
import type { CloudCardAttention } from './cloud-workspace-card-model'

const noop = (): void => {}
const actions = {
  onWake: noop,
  onRestart: noop,
  onArchive: noop,
  onUnarchive: noop,
  onSleep: noop,
  onMoveToComputer: noop,
  onDelete: noop
}

const running: HostedWorkspaceStatus = {
  state: 'ready',
  metrics: {
    cpuPercent: 13,
    cpus: ORCA_CLOUD_SANDBOX_SPEC.vcpus,
    load1: 0.4,
    memTotalBytes: 16.8e9,
    memUsedBytes: 1.8e9,
    diskTotalBytes: 34.3e9,
    diskUsedBytes: 6.2e9,
    uptimeSeconds: 11_520,
    oomKills: 0,
    lastOomVictim: null,
    orcadAlive: true
  },
  uptimeMs: 3 * 3_600_000 + 12 * 60_000,
  usage: { totalMs: 14.6 * 3_600_000, centsPerHour: 100, costCents: 1460 },
  archive: null,
  idleSleepMinutes: 15,
  checkedAt: 1
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
  fetchedAt: 1
})

const FOLDER = '/Users/me/orca/cloud/Hello-World/fix-login-redirect'
function syncView(id: string, mirror: boolean): CloudSyncView {
  const openPath = mirror ? FOLDER : `${FOLDER}/.context`
  return {
    workspaceId: id,
    choice: { context: true, mirror },
    folder: FOLDER,
    phase: 'synced',
    files: mirror ? 1_204 : 12,
    bytes: mirror ? 38_400_000 : 640_000,
    progress: null,
    lastSyncedAt: Date.now() - 2 * 60_000,
    editedHere: 0,
    skippedLarge: 0,
    overLimit: 0,
    limits: { maxBytes: 2_000_000_000, maxFileBytes: 100_000_000 },
    error: null,
    openPath,
    displayPath: openPath.replace('/Users/me', '~')
  }
}

// 2:31 PM today, in the viewer's time zone.
const AS_OF = new Date(new Date().setHours(14, 31, 0, 0)).getTime()

function card({
  id,
  state = 'running',
  mirror = false,
  attention = null,
  layer = 'main',
  details = false
}: {
  id: string
  state?: CloudDotState
  mirror?: boolean
  attention?: CloudCardAttention | null
  layer?: CloudCardLayer
  details?: boolean
}) {
  // Seeded once, outside render: the card reads it through the same store as the live app.
  seedCloudSyncView(syncView(id, mirror))
  return defineFixture({
    width: 320,
    render: () => (
      <div className="w-72 rounded-md border border-border bg-floating-surface p-3">
        <CloudWorkspaceStatusPanel
          workspaceId={id}
          name="fix-login-redirect"
          state={state}
          entry={entry(state === 'sleeping' ? asleep : running)}
          pending={undefined}
          actions={actions}
          attention={attention}
          asOf={AS_OF}
          initialLayer={layer}
          detailsOpen={details}
        />
      </div>
    )
  })
}

/** Default: name, state and idle timer, one usage line, On this computer, Sleep and ⋯. */
export const runningCard = card({ id: 'card-running' })
/** Asleep: "As of" the cached copy; no usage line; Wake. */
export const asleepCard = card({ id: 'card-asleep', state: 'sleeping' })
/** One attention row, the most urgent; it leads to the fix. */
export const runningAttention = card({
  id: 'card-attention',
  attention: { kind: 'agentNotSetUp', agent: 'Claude', tabId: 'tab-1' }
})
/** Details open: the bars, uptime and sandbox hours. */
export const detailsOpen = card({ id: 'card-details', details: true })
/** The sub-panel with the mirror off: the two switches and the .context status. */
export const onComputerMirrorOff = card({ id: 'card-sync-off', layer: 'onComputer' })
/** The sub-panel with the mirror on: where the files are, Open folder and Copy path. */
export const onComputerMirrorOn = card({ id: 'card-sync-on', layer: 'onComputer', mirror: true })

/** The ⋯ menu open: Details, Restart, Move to this computer; Archive and Delete after a separator. */
export const menuOpen = defineFixture({
  width: 320,
  render: () => (
    <div className="w-72 rounded-md border border-border bg-floating-surface p-3">
      <CloudWorkspaceStatusPanel
        workspaceId="card-menu"
        name="fix-login-redirect"
        state="running"
        entry={entry(running)}
        pending={undefined}
        actions={actions}
        attention={null}
        asOf={AS_OF}
        detailsOpen={false}
      />
    </div>
  ),
  interact: async (frame) => {
    frame
      .querySelector<HTMLButtonElement>('[data-cloud-card-more]')
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
})

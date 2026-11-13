import { defineFixture } from '../../component-fixtures/component-fixture'
import { seedCloudSyncView } from '@/lib/orca-cloud/cloud-sync-store'
import { setArchiveTtlDaysForTest } from '@/lib/orca-cloud/archive-ttl'
import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { CloudWorkspaceMark } from './CloudWorkspaceMark'
import type { CloudStatusEntry } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import type { CloudDotState } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import {
  ORCA_CLOUD_SANDBOX_SPEC,
  type HostedWorkspaceStatus
} from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import type { CloudSyncView } from '../../../../shared/cloud-sync/cloud-sync-contract'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { CloudWorkspaceStatusPanel, type CloudCardLayer } from './CloudWorkspaceStatusPanel'
import type { CloudCardAttention } from './cloud-workspace-card-model'

const noop = (): void => {}
// The Archive tooltip's date (the server's TTL comes from /v1/config in the app).
setArchiveTtlDaysForTest(30)
const actions = {
  onWake: noop,
  onRestart: noop,
  onArchive: noop,
  onUnarchive: noop,
  onSleep: noop,
  onMoveToComputer: noop,
  onDelete: noop
}
// A paired row (created on another desktop): everything but Move to this computer (PAIRED-ARCHIVE).
const pairedActions = {
  onWake: noop,
  onRestart: noop,
  onArchive: noop,
  onUnarchive: noop,
  onSleep: noop,
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
// Archived 9 days ago; the snapshot is deleted 21 days from now.
const archived: HostedWorkspaceStatus = {
  ...asleep,
  state: 'archived',
  archive: { archivedAt: Date.now() - 9 * 86_400_000, expiresAt: Date.now() + 21 * 86_400_000 }
}
const entry = (status: HostedWorkspaceStatus): CloudStatusEntry => ({
  status,
  loading: false,
  error: null,
  fetchedAt: 1
})

const FOLDER = '/Users/me/orca/cloud/Hello-World/fix-login-redirect'
function syncView(id: string, mirror: boolean, empty = false): CloudSyncView {
  const openPath = mirror ? FOLDER : `${FOLDER}/.context`
  return {
    workspaceId: id,
    choice: { context: true, mirror },
    folder: FOLDER,
    phase: 'synced',
    files: empty ? 0 : mirror ? 1_204 : 12,
    bytes: empty ? 0 : mirror ? 38_400_000 : 640_000,
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
  emptyContext = false,
  attention = null,
  layer = 'main',
  details = false,
  paired = false
}: {
  id: string
  state?: CloudDotState
  mirror?: boolean
  emptyContext?: boolean
  attention?: CloudCardAttention | null
  layer?: CloudCardLayer
  details?: boolean
  paired?: boolean
}) {
  // Seeded once, outside render: the card reads it through the same store as the live app.
  seedCloudSyncView(syncView(id, mirror, emptyContext))
  return defineFixture({
    width: 320,
    render: () => (
      <div className="w-72 rounded-md border border-border bg-floating-surface p-3">
        <CloudWorkspaceStatusPanel
          workspaceId={id}
          name="fix-login-redirect"
          state={state}
          entry={entry(state === 'sleeping' ? asleep : state === 'archived' ? archived : running)}
          pending={undefined}
          actions={paired ? pairedActions : actions}
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
/** A running agent's sign-in expired: the row's "Sign-in expired", here with the way to Renew. */
export const runningSignInExpired = card({
  id: 'card-expired',
  attention: { kind: 'agentExpired', agent: 'Claude', tabId: 'tab-1' }
})
/** V3-01: a launch put back after a restart that waits for Start: neutral, below the warnings. */
export const runningNotStarted = card({
  id: 'card-not-started',
  attention: { kind: 'agentNotStarted', agent: 'Claude', tabId: 'tab-1' }
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

/** PAIRED-CHROME: a paired row running: Sleep and ⋯ (Delete only). */
export const pairedRunningCard = card({ id: 'card-paired-running', paired: true })
/** PAIRED-CHROME: a paired row asleep: Wake, as on an owned row. */
export const pairedAsleepCard = card({ id: 'card-paired-asleep', state: 'sleeping', paired: true })
/** PAIRED-ARCHIVE: the ⋯ menu on a paired row: Details, Restart, Archive and Delete; no Move. */
export const pairedMenuOpen = defineFixture({
  width: 320,
  render: () => (
    <div className="w-72 rounded-md border border-border bg-floating-surface p-3">
      <CloudWorkspaceStatusPanel
        workspaceId="card-paired-menu"
        name="fix-login-redirect"
        state="running"
        entry={entry(running)}
        pending={undefined}
        actions={pairedActions}
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

/** PAIRED-ARCHIVE: a paired row archived: the same snapshot line and Unarchive as an owned one. */
export const pairedArchivedCard = card({
  id: 'card-paired-archived',
  state: 'archived',
  paired: true
})

/** Archived: the snapshot line names the day it is deleted; Unarchive is the one action. */
export const archivedCard = card({ id: 'card-archived', state: 'archived' })

/** ⋯ open with Archive focused: the shared snapshot definition beside it. */
export const menuArchiveTooltip = defineFixture({
  width: 640,
  render: () => (
    <div className="ms-80 w-72 rounded-md border border-border bg-floating-surface p-3">
      <CloudWorkspaceStatusPanel
        workspaceId="card-menu-archive"
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
    // Typeahead moves focus to Archive (a plain .focus() doesn't stick in Radix menus).
    document
      .querySelector('[role="menu"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 900))
  }
})

/** Nothing in .context yet: "Synced · just now", not "0 files · 0 KB". */
export const onComputerContextEmpty = card({
  id: 'card-sync-empty',
  layer: 'onComputer',
  emptyContext: true
})

const placementRepo: Repo = {
  id: 'hello-world',
  path: '/Users/me/src/Hello-World',
  displayName: 'Hello-World',
  badgeColor: '',
  addedAt: 1
}
const PLACEMENT_ID = 'hello-world::/home/ubuntu/orca/workspaces/Hello-World/fix-login-redirect'
const placementWorktree: Worktree = {
  id: PLACEMENT_ID,
  repoId: placementRepo.id,
  instanceId: 'fix-login-redirect',
  path: '/home/ubuntu/orca/workspaces/Hello-World/fix-login-redirect',
  displayName: 'fix-login-redirect',
  branch: 'fix-login-redirect',
  head: 'abc123',
  isBare: false,
  isMainWorktree: false,
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
}

/** Opened from the sidebar: the card sits beside the sidebar, so the row it describes stays visible. */
export const besideSidebar = defineFixture({
  width: 720,
  // The workspace record, so the card's first line (its name and accessible title) shows.
  store: {
    repos: [placementRepo],
    worktreesByRepo: { [placementRepo.id]: [placementWorktree] }
  },
  setup: () => {
    seedCloudWorkspaceSnapshot({
      ids: new Set([PLACEMENT_ID]),
      idsLoaded: true,
      status: { [PLACEMENT_ID]: entry(running) }
    })
    seedCloudSyncView(syncView(PLACEMENT_ID, false))
  },
  render: () => (
    <div className="flex h-[420px] bg-background">
      <div
        data-left-sidebar=""
        className="w-64 shrink-0 border-e border-border bg-worktree-sidebar p-2"
      >
        <div className="flex items-center gap-2 rounded-md bg-muted/60 px-2 py-1.5 text-[13px]">
          <CloudWorkspaceMark workspaceId={PLACEMENT_ID} />
          <span className="truncate text-foreground">fix-login-redirect</span>
          <span className="ms-auto rounded border border-border px-1 text-[10px] text-muted-foreground">
            Orca Cloud
          </span>
        </div>
      </div>
    </div>
  ),
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('[data-cloud-workspace-mark]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
})

/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { ConfirmationDialogContext } from '../confirmation-dialog-context'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  setActivityTerminalPortals,
  type ActivityTerminalPortalTarget
} from '../activity/activity-terminal-portal'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import {
  acceptReplayedWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshots,
  applyWebSessionTabsStorePatch,
  decideWebSessionTabsSnapshot,
  resetWebSessionTabsSnapshotFreshnessForTests
} from '../../runtime/web-session-tabs-sync'
import { resetHostSessionMirrorHydrationForTests } from '../../runtime/host-session-mirror-hydration'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
import { RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS } from './restored-terminal-spawn-hold'

// Why a marker: the oracle is which tabs Terminal.tsx actually instantiates a
// pane for. A helper-level assertion would still pass with the wiring deleted.
vi.mock('../terminal-pane/TerminalPane', () => ({
  default: ({ tabId }: { tabId: string }) => <div data-mounted-tab={tabId} />
}))
// The tab strip needs app-level providers and decides nothing about mounting.
vi.mock('../tab-bar/TabBar', () => ({ default: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Terminal reaches for a wide slice of window.api on mount; none of it decides
 *  mounting, so every member answers as an inert callable. */
function inertApi(): unknown {
  return new Proxy(function (): void {}, {
    get: (_target, property) => (typeof property === 'symbol' ? undefined : inertApi()),
    apply: () => inertApi()
  })
}

const WORKTREE_ID = 'wt-paired'
const OTHER_WORKTREE_ID = 'wt-other'
const ENVIRONMENT_ID = 'env-1'
const SPAWNING_TAB_IDS = ['row-1', 'row-2', 'row-3', 'row-4', 'row-5']
/** The mirrored and pty-owning rows attach instead of spawning; the pre-existing
 *  coverage deferral independently decides those, so the oracle is the spawn
 *  class alone — exactly the rows this gate governs. */
/** The seeded workspace has no active tab, so useActiveTerminalRepair selects the
 *  first row — and the visible tab is never withheld. */
const SHOWN_ONLY = ['row-1']

function terminalTab(id: string, worktreeId = WORKTREE_ID): TerminalTab {
  return {
    id,
    worktreeId,
    title: id,
    ptyId: null,
    createdAt: 0,
    sortOrder: 0
  } as unknown as TerminalTab
}

/** The persisted rows of a paired workspace reopened after a restart: five
 *  local-uuid rows with no pty anywhere (the spawn class), one mirrored row and
 *  one row whose layout leaf still owns a remote pty (both attach instead). */
const RESTORED_TABS: TerminalTab[] = [
  ...SPAWNING_TAB_IDS.map((id) => terminalTab(id)),
  terminalTab('web-terminal-mirrored'),
  terminalTab('row-adoptable')
]

function hostSnapshot(
  worktree: string,
  overrides: Partial<RuntimeMobileSessionTabsResult> = {}
): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [],
    ...overrides
  }
}

/** Drives the shipping accept path and its settle receipt, so the hold sees an
 *  answer only for frames the store really took. Raw: the `deliver*` wrappers add
 *  the act boundary, and a test needing several events to land with no render
 *  between them composes these directly inside one act block. */
function applyHostSnapshots(
  snapshots: readonly RuntimeMobileSessionTabsResult[],
  environmentId: string,
  fullInventory: boolean
): void {
  const decisions = snapshots.map((snapshot) =>
    decideWebSessionTabsSnapshot(snapshot, environmentId)
  )
  const fresh = snapshots.filter((_snapshot, index) => decisions[index]!.apply)
  const settleMirror = applyWebSessionTabsStorePatch(
    (state) => applyWebSessionTabsSnapshots(state, fresh, environmentId),
    {
      frames: snapshots.map((snapshot, index) => ({
        environmentId,
        worktreeId: snapshot.worktree,
        decision: decisions[index]!
      })),
      ...(fullInventory
        ? { fullInventory: { environmentId, publishedSnapshotCount: snapshots.length } }
        : {})
    }
  )
  settleMirror()
}

/** Raw: a new runtime process. The store action is what advances the canonical
 *  connection generation the hydration latch scopes its verdicts to. */
function connectRuntime(runtimeId: string): void {
  useAppStore
    .getState()
    .setRuntimeEnvironmentStatus(ENVIRONMENT_ID, { status: { runtimeId }, checkedAt: 0 } as never)
}

/** One subscribed worktree's frame: it speaks for that worktree and no other. */
async function deliverHostFrame(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId = ENVIRONMENT_ID
): Promise<void> {
  await act(async () => {
    applyHostSnapshots([snapshot], environmentId, false)
  })
}

/** The listAll/subscribeAll shape: one patch carrying the whole enumeration, so
 *  absence from it is itself the host answering. */
async function deliverHostInventory(
  snapshots: readonly RuntimeMobileSessionTabsResult[]
): Promise<void> {
  await act(async () => {
    applyHostSnapshots(snapshots, ENVIRONMENT_ID, true)
  })
}

/** A reconnect can repeat the frame the client already holds; the shipping
 *  stream arms the replay before offering it to the accept path. */
async function deliverReplayedHostFrame(snapshot: RuntimeMobileSessionTabsResult): Promise<void> {
  await act(async () => {
    acceptReplayedWebSessionTabsSnapshot(ENVIRONMENT_ID, snapshot.worktree)
    applyHostSnapshots([snapshot], ENVIRONMENT_ID, false)
  })
}

async function reconnect(runtimeId: string): Promise<void> {
  await act(async () => {
    connectRuntime(runtimeId)
  })
}

/** Re-pairing points the workspace at another runtime environment. */
async function moveWorktreeToHost(hostId: string): Promise<void> {
  await act(async () => {
    useAppStore.setState(
      (state) =>
        ({
          worktreesByRepo: {
            'repo-1': (state.worktreesByRepo['repo-1'] ?? []).map((worktree) =>
              worktree.id === WORKTREE_ID ? { ...worktree, hostId } : worktree
            )
          }
        }) as never
    )
  })
}

/** A split group holding one active tab; `activeTabId` is a unified-tab id on
 *  current sessions and a raw terminal id on ones persisted before that split. */
function tabGroup(id: string, activeTabId: string): TabGroup {
  return { id, worktreeId: WORKTREE_ID, activeTabId, tabOrder: [activeTabId] }
}

function unifiedTerminalTab(id: string, entityId: string, groupId: string): Tab {
  return {
    id,
    entityId,
    groupId,
    worktreeId: WORKTREE_ID,
    contentType: 'terminal',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

/** An Activity thread portaling one terminal leaf into its own surface. */
function activityPortal(tabId: string, target: HTMLElement): ActivityTerminalPortalTarget {
  return {
    slotId: `slot-${tabId}`,
    requestToken: `token-${tabId}`,
    target,
    worktreeId: WORKTREE_ID,
    tabId,
    paneKey: `pane-${tabId}`,
    active: true
  }
}

function seedStore(
  overrides: {
    runtimeStatus?: { status: unknown; checkedAt: number } | null
    activeTabId?: string | null
    activeWorktreeId?: string
    activeView?: string
    pendingStartupByTabId?: Record<string, unknown>
    groups?: readonly TabGroup[]
    unifiedTabs?: readonly Tab[]
    activeGroupId?: string
    layout?: TabGroupLayoutNode
    /** Runtime environment that owns the worktree under test. */
    hostId?: string
    /** Further environments that are paired and live at the same time. */
    alsoLiveEnvironmentIds?: readonly string[]
  } = {}
): void {
  const runtimeStatus =
    overrides.runtimeStatus === undefined
      ? { status: { runtimeId: 'rt-1' }, checkedAt: 0 }
      : overrides.runtimeStatus
  const runtimeStatusByEnvironmentId = new Map<string, unknown>(
    runtimeStatus ? [[ENVIRONMENT_ID, runtimeStatus]] : []
  )
  for (const environmentId of overrides.alsoLiveEnvironmentIds ?? []) {
    runtimeStatusByEnvironmentId.set(environmentId, {
      status: { runtimeId: `rt-${environmentId}` },
      checkedAt: 0
    })
  }
  useAppStore.setState({
    worktreesByRepo: {
      'repo-1': [
        {
          id: WORKTREE_ID,
          repoId: 'repo-1',
          path: '/tmp/wt',
          hostId: overrides.hostId ?? `runtime:${ENVIRONMENT_ID}`
        },
        {
          id: OTHER_WORKTREE_ID,
          repoId: 'repo-1',
          path: '/tmp/wt-other',
          hostId: `runtime:${ENVIRONMENT_ID}`
        }
      ]
    },
    folderWorkspaces: [],
    activeWorktreeId: overrides.activeWorktreeId ?? WORKTREE_ID,
    activeWorkspaceExecutionHostId: null,
    activeView: overrides.activeView ?? 'terminal',
    activeTabType: 'terminal',
    activeTabId: overrides.activeTabId === undefined ? null : overrides.activeTabId,
    activeTabIdByWorktree: {},
    tabsByWorktree: { [WORKTREE_ID]: RESTORED_TABS, [OTHER_WORKTREE_ID]: [] },
    unifiedTabsByWorktree: overrides.unifiedTabs ? { [WORKTREE_ID]: overrides.unifiedTabs } : {},
    groupsByWorktree: overrides.groups ? { [WORKTREE_ID]: overrides.groups } : {},
    layoutByWorktree: overrides.layout ? { [WORKTREE_ID]: overrides.layout } : {},
    activeGroupIdByWorktree: overrides.activeGroupId
      ? { [WORKTREE_ID]: overrides.activeGroupId }
      : {},
    terminalLayoutsByTabId: {
      'row-adoptable': {
        ptyIdsByLeafId: { '11111111-1111-4111-8111-111111111111': `remote:${ENVIRONMENT_ID}:pty-9` }
      }
    },
    pendingStartupByTabId: overrides.pendingStartupByTabId ?? {},
    openFiles: [],
    browserTabsByWorktree: {},
    workspaceSessionReady: true,
    hydrationSucceeded: true,
    startupWorktreeRefreshCompleted: true,
    runtimeStatusByEnvironmentId
  } as never)
}

const confirmStub = async (): Promise<boolean> => true

let root: Root | null = null
let host: HTMLDivElement | null = null
let portalHost: HTMLDivElement | null = null

/** The Activity surface element a portaled pane renders into. */
function portalTarget(): HTMLDivElement {
  if (!portalHost) {
    portalHost = document.createElement('div')
    document.body.appendChild(portalHost)
  }
  return portalHost
}

async function renderTerminal(): Promise<HTMLDivElement> {
  const { default: Terminal } = await import('@/components/Terminal')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      // Both providers are App-level; split-group chrome renders tooltips.
      <TooltipProvider>
        <ConfirmationDialogContext.Provider value={confirmStub}>
          <Terminal />
        </ConfirmationDialogContext.Provider>
      </TooltipProvider>
    )
  })
  return host
}

function mountedTabIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-mounted-tab]')]
    .map((node) => node.getAttribute('data-mounted-tab') ?? '')
    .sort()
}

/** Mounting one of these issues terminal.create against the paired host. */
function mountedSpawnRows(container: HTMLElement): string[] {
  return mountedTabIds(container).filter((tabId) => SPAWNING_TAB_IDS.includes(tabId))
}

async function advanceBy(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function advancePastDeadline(): Promise<void> {
  await advanceBy(RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS + 1_000)
}

beforeEach(() => {
  vi.useFakeTimers()
  resetWebSessionTabsSnapshotFreshnessForTests()
  resetHostSessionMirrorHydrationForTests()
  clearRuntimeEnvironmentConnectionGenerationsForTests()
  ;(window as unknown as { api: unknown }).api = inertApi()
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  portalHost?.remove()
  setActivityTerminalPortals([])
  root = null
  host = null
  portalHost = null
  vi.useRealTimers()
})

describe('Terminal restored spawn hold (render seam)', () => {
  it('withholds restored pty-less rows on a paired worktree until the host answers', async () => {
    seedStore()
    const container = await renderTerminal()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
  })

  it('always mounts the active tab and any queued startup, even while holding', async () => {
    seedStore({ activeTabId: 'row-1', pendingStartupByTabId: { 'row-2': { command: 'echo hi' } } })
    const container = await renderTerminal()
    // row-1 is visible and row-2 has a startup command with nowhere else to run.
    expect(mountedSpawnRows(container)).toEqual(['row-1', 'row-2'])
  })

  it('never holds a group active tab, through the unified tab or the raw id', async () => {
    // Split mode shows every group's active tab at once, so none may defer. group-1
    // stores the unified-tab id (current sessions); group-2 stores the entity id.
    seedStore({
      activeTabId: 'row-1',
      groups: [tabGroup('group-1', 'unified-row-2'), tabGroup('group-2', 'row-3')],
      unifiedTabs: [unifiedTerminalTab('unified-row-2', 'row-2', 'group-1')],
      activeGroupId: 'group-1',
      layout: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'group-1' },
        second: { type: 'leaf', groupId: 'group-2' }
      }
    })
    const container = await renderTerminal()
    expect(mountedSpawnRows(container)).toEqual(['row-1', 'row-2', 'row-3'])
  })

  it('never holds a tab an activity thread is portaling', async () => {
    // The portaled pane renders into the Activity surface, not the workspace tree.
    seedStore({ activeTabId: 'row-1', activeView: 'activity' })
    setActivityTerminalPortals([activityPortal('row-4', portalTarget())])
    const container = await renderTerminal()
    expect([...mountedSpawnRows(container), ...mountedSpawnRows(portalTarget())].sort()).toEqual([
      'row-1',
      'row-4'
    ])
  })

  it('mounts the attach-class rows the gate does not govern', async () => {
    seedStore()
    const container = await renderTerminal()
    // Mirrored and pty-owning rows cannot spawn, so holding them buys nothing.
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
    expect(mountedTabIds(container)).toContain('web-terminal-mirrored')
    expect(mountedTabIds(container)).toContain('row-adoptable')
  })

  it('does not blank a paired workspace whose runtime is merely disconnected', async () => {
    // A failed probe stores status null: a reachable id, no liveness. The gate
    // still arms — a probe blip must not spend the only cold pass — but the
    // workspace keeps its visible pane and fails open on its own.
    seedStore({ runtimeStatus: { status: null, checkedAt: 0 } })
    const container = await renderTerminal()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SPAWNING_TAB_IDS)
  })

  it('holds when no probe has landed yet and settles once the answer arrives', async () => {
    // Slow start: workspaceSessionReady is true before any status exists.
    seedStore({ runtimeStatus: null })
    const container = await renderTerminal()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
    await reconnect('rt-1')
    await deliverHostFrame(hostSnapshot(WORKTREE_ID))
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
  })

  it('waits on the environment that owns the worktree, not any live one', async () => {
    seedStore({ hostId: 'runtime:env-2', alsoLiveEnvironmentIds: ['env-2'] })
    const container = await renderTerminal()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
    // An answer from the other paired environment says nothing about this one.
    await deliverHostFrame(hostSnapshot(WORKTREE_ID), ENVIRONMENT_ID)
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SPAWNING_TAB_IDS)
  })

  it('settles on an answer from the environment that owns the worktree', async () => {
    seedStore({ hostId: 'runtime:env-2', alsoLiveEnvironmentIds: ['env-2'] })
    const container = await renderTerminal()
    await deliverHostFrame(hostSnapshot(WORKTREE_ID), 'env-2')
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
  })

  it('fails open and mounts held rows when no answer ever arrives', async () => {
    seedStore()
    const container = await renderTerminal()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SPAWNING_TAB_IDS)
  })

  it('measures its silence from the live connection, not the one it armed on', async () => {
    seedStore()
    const container = await renderTerminal()
    const halfWindow = RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS / 2
    await advanceBy(halfWindow)
    await reconnect('rt-2')
    // Past the first window's deadline, but this connection has not been silent
    // that long: a reconnect owes the hold a fresh window.
    await advanceBy(halfWindow + 1_000)
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SPAWNING_TAB_IDS)
  })

  it('starts a fresh window when the workspace moves to a host at the same generation', async () => {
    // Neither environment has connected in this test, so both sit at generation 0:
    // only host identity separates the two epochs.
    seedStore({ alsoLiveEnvironmentIds: ['env-2'] })
    const container = await renderTerminal()
    await advanceBy(RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS - 2_000)
    await moveWorktreeToHost('runtime:env-2')
    // Past the first host's deadline, but env-2 has been silent for 2s, not 20s.
    await advanceBy(4_000)
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SPAWNING_TAB_IDS)
  })

  it('never lets the previous host answer for the one the workspace moved to', async () => {
    seedStore({ alsoLiveEnvironmentIds: ['env-2'] })
    const container = await renderTerminal()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
    await deliverHostFrame(hostSnapshot(WORKTREE_ID))
    await moveWorktreeToHost('runtime:env-2')
    // Inheriting env-1's verdict would leave this workspace dark forever on a host
    // that never answered, which is exactly the wedge a mount gate must not cause.
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SPAWNING_TAB_IDS)
  })

  it('keeps rows dark past the deadline once an empty snapshot proves them dead', async () => {
    seedStore()
    const container = await renderTerminal()
    // The answer patches no held row into the store; only a later render sees it.
    await deliverHostFrame(hostSnapshot(WORKTREE_ID))
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
  })

  it('settles on a full inventory that covers the worktree', async () => {
    seedStore()
    const container = await renderTerminal()
    await deliverHostInventory([hostSnapshot(OTHER_WORKTREE_ID), hostSnapshot(WORKTREE_ID)])
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
  })

  it('settles on a full inventory that omits the worktree', async () => {
    // An inventory enumerates every worktree the host knows, so omission is an
    // answer too: these rows exist on no host session.
    seedStore()
    const container = await renderTerminal()
    await deliverHostInventory([hostSnapshot(OTHER_WORKTREE_ID)])
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
  })

  it('does not settle on a single frame published for another worktree', async () => {
    seedStore()
    const container = await renderTerminal()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
    await deliverHostFrame(hostSnapshot(OTHER_WORKTREE_ID))
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SPAWNING_TAB_IDS)
  })

  it('settles on a reconnect replay of the frame it already held', async () => {
    // Identity repeats across a reconnect; the receipt does not.
    seedStore()
    await deliverHostFrame(hostSnapshot(WORKTREE_ID))
    const container = await renderTerminal()
    await reconnect('rt-2')
    await deliverReplayedHostFrame(hostSnapshot(WORKTREE_ID))
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
  })

  it('does not carry an answer from the previous connection into a new hold', async () => {
    seedStore()
    const container = await renderTerminal()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
    // One batch, so no render observes the answer while its connection is still
    // current: the client only ever sees it stamped with a superseded generation.
    await act(async () => {
      applyHostSnapshots([hostSnapshot(WORKTREE_ID)], ENVIRONMENT_ID, false)
      connectRuntime('rt-2')
    })
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SPAWNING_TAB_IDS)
  })

  it('settles on evidence this connection already accepted before the hold armed', async () => {
    // Reopening a workspace the host answered for must not run the storm late.
    seedStore()
    await deliverHostFrame(hostSnapshot(WORKTREE_ID))
    const container = await renderTerminal()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
  })

  it('never re-holds rows a previous activation already mounted', async () => {
    seedStore()
    const container = await renderTerminal()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SPAWNING_TAB_IDS)
    // Reconnect, then leave and re-enter so a fresh activation pass runs.
    await reconnect('rt-2')
    await act(async () => {
      useAppStore.setState({ activeWorktreeId: OTHER_WORKTREE_ID } as never)
    })
    await act(async () => {
      useAppStore.setState({ activeWorktreeId: WORKTREE_ID } as never)
    })
    expect(mountedSpawnRows(container)).toEqual(SPAWNING_TAB_IDS)
  })
})

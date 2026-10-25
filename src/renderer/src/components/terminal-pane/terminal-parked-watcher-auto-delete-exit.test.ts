import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const WORKTREE_ID = 'repo::/worktree'
const TAB_ID = 'tab-1'
const PTY_ID = `${WORKTREE_ID}@@session-1`
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

vi.mock('./parked-terminal-byte-watcher', () => ({
  startParkedTerminalByteWatcher: () => vi.fn()
}))

type ExitCallback = (code: number, context: { hadPrimary: boolean }) => void
const exitCallbacksByPtyId = new Map<string, ExitCallback>()
vi.mock('./pty-dispatcher', () => ({
  subscribeToPtyExit: (ptyId: string, callback: ExitCallback) => {
    exitCallbacksByPtyId.set(ptyId, callback)
    return vi.fn()
  }
}))
vi.mock('./pty-pre-handler-buffer', () => ({
  consumePreHandlerPtyState: vi.fn(),
  discardPreHandlerPtyState: vi.fn(),
  hasPreHandlerPtyExit: () => false
}))

// Why land the close: the auto-delete reaction runs from the close's onClosed.
const closeTerminalTab = vi.fn((_tabId: string, options?: { onClosed?: () => void }) =>
  options?.onClosed?.()
)
vi.mock('../terminal/terminal-tab-actions', () => ({
  closeTerminalTab: (tabId: string, options?: { onClosed?: () => void }) =>
    closeTerminalTab(tabId, options)
}))

const enqueue = vi.fn()
vi.mock('@/lib/last-tab-auto-delete/last-tab-auto-delete-queue', () => ({
  enqueueLastTabAutoDelete: (candidate: unknown) => enqueue(candidate)
}))

type Row = { id: string; repoId: string; hostId: string; instanceId: string }
let mockStoreState: {
  settings: { deleteWorkspaceOnLastTabClose: string }
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: string | null
  worktreesByRepo: Record<string, Row[]>
  unifiedTabsByWorktree: Record<string, { entityId: string; executionHostId?: string }[]>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  clearRuntimePaneTitle: ReturnType<typeof vi.fn>
  markUnverifiedPtyLoss: ReturnType<typeof vi.fn>
  isPtyShutdownPending: ReturnType<typeof vi.fn>
  suppressedPtyExitIds: Record<string, true>
  reconcileWorktreeTabModel: () => { renderableTabCount: number }
  setActiveWorktree: ReturnType<typeof vi.fn>
}
vi.mock('@/store', () => ({ useAppStore: { getState: () => mockStoreState } }))

import { markCommittedPtyShutdowns } from './pty-shutdown-exit-deferral'
import { parkedWatchersByTabId } from './terminal-parked-watcher-registry'
import { startParkedPtyWatcher } from './terminal-parked-pty-watcher'
import type {
  ParkedTabWatcherEntry,
  ParkedTerminalPaneCapture
} from './terminal-parked-watcher-registry'

const localRow: Row = { id: WORKTREE_ID, repoId: 'repo', hostId: 'local', instanceId: 'i-local' }
const sshRow: Row = { id: WORKTREE_ID, repoId: 'repo', hostId: 'ssh:box', instanceId: 'i-ssh' }

function startWatcher(pane: Partial<ParkedTerminalPaneCapture> = {}): ParkedTabWatcherEntry {
  const entry: ParkedTabWatcherEntry = {
    worktreeId: WORKTREE_ID,
    tabPtyId: PTY_ID,
    paneIdByPtyId: new Map(),
    disposersByPtyId: new Map()
  }
  parkedWatchersByTabId.set(TAB_ID, entry)
  startParkedPtyWatcher({
    worktreeId: WORKTREE_ID,
    tab: { id: TAB_ID, ptyId: PTY_ID },
    pane: { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true, ...pane },
    entry,
    restoreTitleOnRegister: false,
    restorePolicy: {}
  })
  return entry
}

const exit = (code = 0) => exitCallbacksByPtyId.get(PTY_ID)?.(code, { hadPrimary: false })

describe('parked terminal exit and last-tab auto-delete', () => {
  beforeEach(() => {
    mockStoreState = {
      settings: { deleteWorkspaceOnLastTabClose: 'close-or-exit-background' },
      activeWorktreeId: 'other',
      activeWorkspaceExecutionHostId: 'local',
      worktreesByRepo: { repo: [localRow] },
      unifiedTabsByWorktree: {},
      runtimePaneTitlesByTabId: {},
      clearRuntimePaneTitle: vi.fn(),
      markUnverifiedPtyLoss: vi.fn(),
      isPtyShutdownPending: vi.fn(() => false),
      suppressedPtyExitIds: {},
      reconcileWorktreeTabModel: () => ({ renderableTabCount: 0 }),
      setActiveWorktree: vi.fn()
    }
  })
  afterEach(() => {
    exitCallbacksByPtyId.clear()
    parkedWatchersByTabId.clear()
    vi.clearAllMocks()
  })

  it('queues a background exit candidate after the usual close cleanup', () => {
    startWatcher()
    exit()
    expect(closeTerminalTab).toHaveBeenCalledTimes(1)
    expect(parkedWatchersByTabId.has(TAB_ID)).toBe(false)
    expect(enqueue).toHaveBeenCalledWith({
      workspaceKey: WORKTREE_ID,
      trigger: 'exit',
      wasActive: false,
      hostId: 'local',
      instanceId: 'i-local'
    })
  })

  it.each([
    ['pending renderer shutdown', () => mockStoreState.isPtyShutdownPending.mockReturnValue(true)],
    ['suppressed intentional restart', () => (mockStoreState.suppressedPtyExitIds[PTY_ID] = true)],
    ['committed shutdown marker', () => markCommittedPtyShutdowns([PTY_ID])]
  ] as const)('queues nothing for an exit during a %s', (_marker, arm) => {
    startWatcher()
    arm()
    exit()
    expect(closeTerminalTab).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('keeps the selection of an active workspace emptied by a parked exit', () => {
    mockStoreState.activeWorktreeId = WORKTREE_ID
    startWatcher()
    exit()
    expect(mockStoreState.setActiveWorktree).not.toHaveBeenCalled()
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ wasActive: true }))
  })

  it('queues nothing for an unproven exit or an untouched fresh shell', () => {
    startWatcher()
    exit(-1)
    exitCallbacksByPtyId.clear()
    startWatcher({ untouchedFreshSpawn: true })
    exit()
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('takes the host from the pane owner when two hosts publish the id', () => {
    mockStoreState.worktreesByRepo = { repo: [localRow, sshRow] }
    startWatcher({ workspaceOwner: { executionHostId: 'ssh:box', runtimeEnvironmentId: null } })
    exit()
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: 'ssh:box', instanceId: 'i-ssh' })
    )
  })

  it('takes the host from the unified tab when the pane names no owner', () => {
    mockStoreState.worktreesByRepo = { repo: [localRow, sshRow] }
    mockStoreState.unifiedTabsByWorktree = {
      [WORKTREE_ID]: [{ entityId: TAB_ID, executionHostId: 'ssh:box' }]
    }
    startWatcher()
    exit()
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'ssh:box' }))
  })

  it('queues nothing when neither the pane nor the tab can name one of two hosts', () => {
    mockStoreState.worktreesByRepo = { repo: [localRow, sshRow] }
    startWatcher()
    exit()
    expect(closeTerminalTab).toHaveBeenCalledTimes(1)
    expect(enqueue).not.toHaveBeenCalled()
  })
})

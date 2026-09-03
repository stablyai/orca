import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { activateAndRevealFolderWorkspace, activateAndRevealWorktree } from './worktree-activation'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import {
  makeCreatedAgentWorktree as makeWorktree,
  seedEmptyActivatableWorktree
} from '@/lib/worktree-activation-created-agent-test-state'
import { waitForWorktreeAgentActivationGateForTests } from './worktree-agent-activation-gate'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

/** The state a workspace lands in once its last terminal is closed: the row survives as an
 *  explicit empty list rather than disappearing. */
function seedClosedLastTerminal(worktreeId: string): void {
  useAppStore.setState({ tabsByWorktree: { [worktreeId]: [] } })
  const { renderableTabCount } = useAppStore.getState().reconcileWorktreeTabModel(worktreeId)
  expect(renderableTabCount).toBe(0)
}

describe('activating a workspace whose last terminal was closed', () => {
  it('re-seeds a terminal when the workspace is opened from elsewhere', () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    seedClosedLastTerminal(worktree.id)

    const result = activateAndRevealWorktree(worktree.id, { notifyHostRuntime: false })

    expect(result).not.toBe(false)
    expect(result === false ? null : result.primaryTabId).toBeTruthy()
    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toHaveLength(1)
  })

  // Why: hydration restores an emptied workspace as active, so the user is already looking at the
  // blank pane when they click its row. Suppressing the re-seed there strands them on the bug.
  it('re-seeds when the restored active workspace is reopened on the same host', () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    seedClosedLastTerminal(worktree.id)
    useAppStore.setState({
      activeWorktreeId: worktree.id,
      activeWorkspaceExecutionHostId: 'local',
      activeView: 'terminal'
    })

    activateAndRevealWorktree(worktree.id, {
      executionHostId: 'local',
      notifyHostRuntime: false
    })

    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toHaveLength(1)
  })

  // Why: entry points disagree about whether to pass a host for the same local workspace — the
  // sidebar derives 'local', the Cmd+J palette passes nothing. Re-seeding no longer reads the
  // host at all; this guards against reintroducing a host-sensitive carve-out.
  it('re-seeds identically whether or not the caller passes an execution host', () => {
    for (const opts of [{}, { executionHostId: 'local' as const }]) {
      const worktree = makeWorktree()
      seedEmptyActivatableWorktree(worktree)
      seedClosedLastTerminal(worktree.id)
      useAppStore.setState({
        activeWorktreeId: worktree.id,
        activeWorkspaceExecutionHostId: 'local',
        activeView: 'terminal'
      })

      activateAndRevealWorktree(worktree.id, { ...opts, notifyHostRuntime: false })

      expect(useAppStore.getState().tabsByWorktree[worktree.id]).toHaveLength(1)
    }
  })

  // Why: terminal file links and check annotations activate only to route history before they
  // open an editor tab. Seeding there hands the user a shell they never asked for and erases the
  // tombstone permanently. See terminal-file-open-routing.ts and check-annotation-open.ts.
  it('leaves the row empty when the caller opens its own surface', () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    seedClosedLastTerminal(worktree.id)

    const result = activateAndRevealWorktree(worktree.id, {
      providesInitialSurface: true,
      notifyHostRuntime: false
    })

    expect(result).not.toBe(false)
    expect(result === false ? null : result.primaryTabId).toBeNull()
    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toEqual([])
  })

  it('leaves the row empty for startup hydration, which never opts into re-seeding', () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    seedClosedLastTerminal(worktree.id)

    const tabId = ensureWorktreeHasInitialTerminal(useAppStore.getState(), worktree.id)

    expect(tabId).toBeNull()
    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toEqual([])
  })

  // Why: this passes ahead of the tombstone check — a renderable browser tab short-circuits
  // `shouldAutoCreateInitialTerminal` — so it guards `renderableTabCount`, not the re-seed flag.
  it('does not add a terminal to a workspace that still renders a browser tab', () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    seedClosedLastTerminal(worktree.id)
    useAppStore.setState({
      browserTabsByWorktree: {
        [worktree.id]: [
          {
            id: 'browser-1',
            worktreeId: worktree.id,
            url: 'https://example.com',
            title: 'example',
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      unifiedTabsByWorktree: {
        [worktree.id]: [
          {
            id: 'browser-1',
            entityId: 'browser-1',
            groupId: 'group-1',
            worktreeId: worktree.id,
            contentType: 'browser',
            label: 'example',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      groupsByWorktree: {
        [worktree.id]: [
          {
            id: 'group-1',
            worktreeId: worktree.id,
            activeTabId: 'browser-1',
            tabOrder: ['browser-1']
          }
        ]
      },
      activeGroupIdByWorktree: { [worktree.id]: 'group-1' }
    } as unknown as Partial<ReturnType<typeof useAppStore.getState>>)
    expect(
      useAppStore.getState().reconcileWorktreeTabModel(worktree.id).renderableTabCount
    ).toBeGreaterThan(0)

    activateAndRevealWorktree(worktree.id, { notifyHostRuntime: false })

    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toEqual([])
  })
})

const FOLDER_ID = 'folder-1'
const FOLDER_KEY = folderWorkspaceKey(FOLDER_ID)
const SSH_HOST_ID = toSshExecutionHostId('conn-1')

/** One folder id resolves to a different `FolderWorkspace` per host while both share a single
 *  `tabsByWorktree[FOLDER_KEY]` row. */
function seedEmptiedFolderWorkspaceOnTwoHosts(): void {
  const base = {
    id: FOLDER_ID,
    projectGroupId: 'group-1',
    name: 'notes',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0
  }
  useAppStore.setState({
    folderWorkspaces: [
      { ...base, folderPath: '/local/notes', executionHostId: 'local' },
      // Why: an SSH host, not a runtime one — runtime-owned workspaces return early from
      // `ensureWorktreeHasInitialTerminal` because the host owns terminal creation.
      { ...base, folderPath: '/remote/notes', executionHostId: SSH_HOST_ID, connectionId: 'conn-1' }
    ],
    activeView: 'terminal',
    tabsByWorktree: { [FOLDER_KEY]: [] },
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    getFreshFolderWorkspacePathStatus: () => ({ exists: true }),
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    revealWorktreeInSidebar: vi.fn()
  } as unknown as Partial<ReturnType<typeof useAppStore.getState>>)
  expect(useAppStore.getState().reconcileWorktreeTabModel(FOLDER_KEY).renderableTabCount).toBe(0)
}

describe('activating a folder workspace whose last terminal was closed', () => {
  it('re-seeds a terminal when the workspace is opened', () => {
    seedEmptiedFolderWorkspaceOnTwoHosts()

    const result = activateAndRevealFolderWorkspace(FOLDER_ID, { executionHostId: 'local' })

    expect(result).not.toBe(false)
    expect(useAppStore.getState().tabsByWorktree[FOLDER_KEY]).toHaveLength(1)
  })

  it('re-seeds when the restored active folder workspace is reopened on the same host', () => {
    seedEmptiedFolderWorkspaceOnTwoHosts()
    useAppStore.setState({
      activeWorktreeId: FOLDER_KEY,
      activeWorkspaceExecutionHostId: 'local'
    })

    activateAndRevealFolderWorkspace(FOLDER_ID, { executionHostId: 'local' })

    expect(useAppStore.getState().tabsByWorktree[FOLDER_KEY]).toHaveLength(1)
  })

  // Why: the opt-out must mean the same thing on both workspace shapes, or routing a
  // file link through a folder workspace would silently regress to seeding a shell.
  it('leaves the row empty when the caller opens its own surface', async () => {
    seedEmptiedFolderWorkspaceOnTwoHosts()
    useAppStore.setState({
      workspaceSessionReady: true,
      terminalStartupRestorationReady: true
    })
    vi.stubGlobal('window', {
      api: {
        runtime: {
          call: vi.fn(async () => ({ ok: true, result: { snapshots: [] } }))
        },
        pty: { listSessions: vi.fn(async () => []) }
      }
    })

    const result = activateAndRevealFolderWorkspace(FOLDER_ID, {
      executionHostId: 'local',
      providesInitialSurface: true
    })
    await waitForWorktreeAgentActivationGateForTests(FOLDER_KEY)

    expect(result).not.toBe(false)
    expect(result === false ? null : result.primaryTabId).toBeNull()
    expect(useAppStore.getState().tabsByWorktree[FOLDER_KEY]).toEqual([])
  })

  // Why: this asserts the row is re-seeded, NOT that the tab lands on the requested host.
  // getFolderWorkspaceConnectionId is host-blind (folder-workspace-connection.ts:68 takes the
  // first id match), so the created tab resolves local even here. That defect is pre-existing —
  // it reproduces with no row at all, on the ordinary auto-create path — and is out of scope.
  it('re-seeds the shared row when opening the same folder id on a different host', () => {
    seedEmptiedFolderWorkspaceOnTwoHosts()
    useAppStore.setState({
      activeWorktreeId: FOLDER_KEY,
      activeWorkspaceExecutionHostId: 'local'
    })

    const result = activateAndRevealFolderWorkspace(FOLDER_ID, { executionHostId: SSH_HOST_ID })

    expect(result).not.toBe(false)
    expect(useAppStore.getState().tabsByWorktree[FOLDER_KEY]).toHaveLength(1)
  })
})

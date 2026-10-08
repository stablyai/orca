import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { activateAndRevealFolderWorkspace, activateAndRevealWorktree } from './worktree-activation'
import * as activationGate from './worktree-agent-activation-gate'
import {
  ensureWorktreeHasInitialTerminal,
  reseedGatedEmptyWorkspace
} from './worktree-initial-terminal-seeding'
import {
  isEmptyWorkspaceDefaultSurfacePending,
  releaseEmptyWorkspaceDefaultSurface
} from './empty-workspace-default-surface-claims'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  makeCreatedAgentWorktree as makeWorktree,
  seedEmptyActivatableWorktree
} from '@/lib/worktree-activation-created-agent-test-state'
import {
  createMockStore,
  registerWorktreeActivationReset
} from './worktree-activation-test-harness'

const defaultChat = vi.hoisted(() => ({
  open: vi.fn(),
  awaitsDetection: vi.fn(),
  loadDetection: vi.fn()
}))

vi.mock('@/lib/empty-workspace-default-agent-chat', () => ({
  openDefaultAgentChatInEmptyWorkspace: defaultChat.open,
  emptyWorkspaceDefaultChatAwaitsDetection: defaultChat.awaitsDetection,
  loadEmptyWorkspaceDefaultChatDetection: defaultChat.loadDetection
}))

const USER_OPEN = { navigationIntent: 'user-open' } as const
const FOLDER_ID = 'folder-1'
const FOLDER_KEY = folderWorkspaceKey(FOLDER_ID)
const initialAppStoreState = useAppStore.getState()

registerWorktreeActivationReset()

beforeEach(() => {
  defaultChat.open.mockReset()
  defaultChat.awaitsDetection.mockReset().mockReturnValue(false)
  defaultChat.loadDetection.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  releaseEmptyWorkspaceDefaultSurface(makeWorktree().id)
  releaseEmptyWorkspaceDefaultSurface(FOLDER_KEY)
  useAppStore.setState(initialAppStoreState, true)
})

/** Electron exposes the PTY inventory, so an empty workspace is seeded by the gated reseed. */
function useElectronActivationGate(): ReturnType<typeof vi.spyOn> {
  vi.stubGlobal('window', { api: { runtime: { call: vi.fn() }, pty: { listSessions: vi.fn() } } })
  return vi.spyOn(activationGate, 'gateWorktreeAgentActivation').mockResolvedValue('empty')
}

function seedEmptyFolderWorkspace(): void {
  useAppStore.setState({
    folderWorkspaces: [
      {
        id: FOLDER_ID,
        projectGroupId: 'group-1',
        name: 'notes',
        folderPath: '/local/notes',
        executionHostId: 'local',
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0
      }
    ],
    activeView: 'terminal',
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    getFreshFolderWorkspacePathStatus: () => ({ exists: true }),
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    revealWorktreeInSidebar: vi.fn()
  } as unknown as Partial<ReturnType<typeof useAppStore.getState>>)
}

function tabCount(workspaceKey: string): number {
  return (useAppStore.getState().tabsByWorktree[workspaceKey] ?? []).length
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// Why: with chat as the default view, clicking an empty workspace used to open a bare shell the
// user then had to turn into a chat by hand.
describe('empty workspace seeding with a default agent chat', () => {
  it('opens the default agent chat instead of a shell', () => {
    defaultChat.open.mockReturnValue({ primaryTabId: 'chat-tab' })
    const createTab = vi.fn(() => ({ id: 'shell-tab' }))
    const store = createMockStore({ createTab })

    const primaryTabId = ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      undefined,
      undefined,
      undefined,
      undefined,
      { seedUserDefaultSurface: true }
    )

    expect(defaultChat.open).toHaveBeenCalledWith('wt-1', expect.any(Function))
    expect(primaryTabId).toBe('chat-tab')
    expect(createTab).not.toHaveBeenCalled()
  })

  // A host's "no" to the chat seeds the shell this workspace would have had, not the agent's TUI.
  it('seeds the plain shell when the host declines the default chat', () => {
    defaultChat.open.mockImplementation((_worktreeId: string, seedShell: () => boolean) => {
      seedShell()
      return { primaryTabId: null }
    })
    const createTab = vi.fn(() => ({ id: 'shell-tab' }))
    const store = createMockStore({ createTab })

    ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, undefined, undefined, undefined, {
      seedUserDefaultSurface: true
    })

    expect(defaultChat.open).toHaveBeenCalledOnce()
    expect(createTab).toHaveBeenCalledOnce()
    expect(createTab).toHaveBeenCalledWith(
      'wt-1',
      undefined,
      undefined,
      expect.not.objectContaining({ launchAgent: expect.anything() })
    )
  })

  it('falls back to a shell when no chat can open', () => {
    defaultChat.open.mockReturnValue(null)
    const createTab = vi.fn(() => ({ id: 'shell-tab' }))
    const store = createMockStore({ createTab })

    const primaryTabId = ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      undefined,
      undefined,
      undefined,
      undefined,
      { seedUserDefaultSurface: true }
    )

    expect(primaryTabId).toBe('shell-tab')
    expect(createTab).toHaveBeenCalledTimes(1)
  })

  it('keeps the shell for seeds that did not ask for the default surface', () => {
    const store = createMockStore({ createTab: vi.fn(() => ({ id: 'shell-tab' })) })

    ensureWorktreeHasInitialTerminal(store, 'wt-1')
    ensureWorktreeHasInitialTerminal(store, 'wt-2', undefined, undefined, undefined, undefined, {
      seedUserDefaultSurface: true,
      activateCreatedTabs: false
    })

    expect(defaultChat.open).not.toHaveBeenCalled()
  })

  it('a user open of an empty workspace asks for the default surface', () => {
    defaultChat.open.mockReturnValue({ primaryTabId: null })
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)

    activateAndRevealWorktree(worktree.id, { ...USER_OPEN, notifyHostRuntime: false })

    expect(defaultChat.open).toHaveBeenCalledWith(worktree.id, expect.any(Function))
  })

  it('back/forward navigation asks for the default surface', () => {
    defaultChat.open.mockReturnValue({ primaryTabId: null })
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    useAppStore.setState({
      worktreeNavHistory: [worktree.id, 'repo-1::/elsewhere'],
      worktreeNavHistoryIndex: 1
    })

    useAppStore.getState().goBackWorktree()

    expect(defaultChat.open).toHaveBeenCalledWith(worktree.id, expect.any(Function))
  })

  // Why: CLI/phone creates, fallbacks after a failed agent launch, and the move after a delete
  // activate with no intent; none of them may start an agent nobody picked.
  it.each([
    ['no navigation intent', {}],
    ['a Blank Terminal pick', { ...USER_OPEN, agent: null }]
  ])('keeps the shell for %s', (_label, selection) => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)

    activateAndRevealWorktree(worktree.id, { ...selection, notifyHostRuntime: false })

    expect(defaultChat.open).not.toHaveBeenCalled()
    expect(tabCount(worktree.id)).toBe(1)
  })
})

describe('the gated reseed that seeds an empty workspace in Electron', () => {
  it('opens the default agent chat for a user open', async () => {
    defaultChat.open.mockReturnValue({ primaryTabId: null })
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    const gate = useElectronActivationGate()

    const result = activateAndRevealWorktree(worktree.id, {
      ...USER_OPEN,
      notifyHostRuntime: false
    })
    expect(result === false ? 'failed' : result.primaryTabId).toBeNull()
    await gate.mock.results[0]?.value

    expect(defaultChat.open).toHaveBeenCalledWith(worktree.id, expect.any(Function))
    expect(tabCount(worktree.id)).toBe(0)
  })

  it('seeds a shell for an activation without a user open', async () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    const gate = useElectronActivationGate()

    activateAndRevealWorktree(worktree.id, { notifyHostRuntime: false })
    await gate.mock.results[0]?.value

    expect(defaultChat.open).not.toHaveBeenCalled()
    expect(tabCount(worktree.id)).toBe(1)
  })

  it('opens the default agent chat for a user-opened folder workspace', async () => {
    defaultChat.open.mockReturnValue({ primaryTabId: null })
    seedEmptyFolderWorkspace()
    const gate = useElectronActivationGate()

    activateAndRevealFolderWorkspace(FOLDER_ID, { ...USER_OPEN, executionHostId: 'local' })
    await gate.mock.results[0]?.value

    expect(defaultChat.open).toHaveBeenCalledWith(FOLDER_KEY, expect.any(Function))
    expect(tabCount(FOLDER_KEY)).toBe(0)
  })

  it('waits for the host agent list and lets no other reseed seed a shell meanwhile', async () => {
    defaultChat.open.mockReturnValue({ primaryTabId: null })
    defaultChat.awaitsDetection.mockReturnValue(true)
    let finishDetection!: () => void
    defaultChat.loadDetection.mockReturnValue(
      new Promise<void>((resolve) => {
        finishDetection = resolve
      })
    )
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    const gate = useElectronActivationGate()

    activateAndRevealWorktree(worktree.id, { ...USER_OPEN, notifyHostRuntime: false })
    await gate.mock.results[0]?.value

    expect(defaultChat.loadDetection).toHaveBeenCalledWith(worktree.id)
    expect(isEmptyWorkspaceDefaultSurfacePending(worktree.id)).toBe(true)
    reseedGatedEmptyWorkspace(worktree.id, {
      callerProvidesSurface: false,
      seedUserDefaultSurface: false
    })
    expect(tabCount(worktree.id)).toBe(0)
    expect(defaultChat.open).not.toHaveBeenCalled()

    finishDetection()
    await flushPromises()

    expect(isEmptyWorkspaceDefaultSurfacePending(worktree.id)).toBe(false)
    expect(defaultChat.open).toHaveBeenCalledTimes(1)
    expect(tabCount(worktree.id)).toBe(0)
  })

  // Why: the wait used to keep the first activation's intent, so returning to the workspace through
  // history (no host id) failed the first intent's host check and left it with no surface at all.
  it('seeds for the latest activation when the workspace is reopened during the wait', async () => {
    defaultChat.open.mockReturnValue({ primaryTabId: null })
    defaultChat.awaitsDetection.mockReturnValue(true)
    let finishDetection!: () => void
    defaultChat.loadDetection.mockReturnValue(
      new Promise<void>((resolve) => {
        finishDetection = resolve
      })
    )
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    const gate = useElectronActivationGate()

    activateAndRevealWorktree(worktree.id, {
      ...USER_OPEN,
      executionHostId: 'local',
      notifyHostRuntime: false
    })
    await gate.mock.results[0]?.value
    useAppStore.setState({ activeWorktreeId: 'repo-1::/elsewhere' })
    activateAndRevealWorktree(worktree.id, { ...USER_OPEN, notifyHostRuntime: false })
    await gate.mock.results[1]?.value
    expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBeNull()
    finishDetection()
    await flushPromises()

    expect(defaultChat.loadDetection).toHaveBeenCalledTimes(1)
    expect(isEmptyWorkspaceDefaultSurfacePending(worktree.id)).toBe(false)
    expect(defaultChat.open).toHaveBeenCalledTimes(1)
  })

  it('seeds a shell when a plain activation follows the user open during the wait', async () => {
    defaultChat.awaitsDetection.mockReturnValue(true)
    let finishDetection!: () => void
    defaultChat.loadDetection.mockReturnValue(
      new Promise<void>((resolve) => {
        finishDetection = resolve
      })
    )
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    const gate = useElectronActivationGate()

    activateAndRevealWorktree(worktree.id, { ...USER_OPEN, notifyHostRuntime: false })
    await gate.mock.results[0]?.value
    activateAndRevealWorktree(worktree.id, { notifyHostRuntime: false })
    await gate.mock.results[1]?.value
    expect(tabCount(worktree.id)).toBe(0)
    finishDetection()
    await flushPromises()

    expect(defaultChat.open).not.toHaveBeenCalled()
    expect(tabCount(worktree.id)).toBe(1)
  })

  it('re-checks the active workspace after the wait', async () => {
    defaultChat.awaitsDetection.mockReturnValue(true)
    let finishDetection!: () => void
    defaultChat.loadDetection.mockReturnValue(
      new Promise<void>((resolve) => {
        finishDetection = resolve
      })
    )
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    const gate = useElectronActivationGate()

    activateAndRevealWorktree(worktree.id, { ...USER_OPEN, notifyHostRuntime: false })
    await gate.mock.results[0]?.value
    useAppStore.setState({ activeWorktreeId: 'repo-1::/elsewhere' })
    finishDetection()
    await flushPromises()

    expect(isEmptyWorkspaceDefaultSurfacePending(worktree.id)).toBe(false)
    expect(defaultChat.open).not.toHaveBeenCalled()
    expect(tabCount(worktree.id)).toBe(0)
  })

  it('seeds the shell when detection fails', async () => {
    defaultChat.open.mockReturnValue(null)
    defaultChat.awaitsDetection.mockReturnValue(true)
    defaultChat.loadDetection.mockRejectedValue(new Error('ssh probe failed'))
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    const gate = useElectronActivationGate()

    activateAndRevealWorktree(worktree.id, { ...USER_OPEN, notifyHostRuntime: false })
    await gate.mock.results[0]?.value
    await flushPromises()

    expect(isEmptyWorkspaceDefaultSurfacePending(worktree.id)).toBe(false)
    expect(tabCount(worktree.id)).toBe(1)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from './worktree-activation'
import * as activationGate from './worktree-agent-activation-gate'
import { reseedGatedEmptyWorkspace } from './worktree-initial-terminal-seeding'
import {
  isEmptyWorkspaceDefaultSurfacePending,
  releaseEmptyWorkspaceDefaultSurface
} from './empty-workspace-default-surface-claims'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  makeCreatedAgentWorktree as makeWorktree,
  seedEmptyActivatableWorktree
} from '@/lib/worktree-activation-created-agent.test-fixture'
import { registerWorktreeActivationReset } from './worktree-activation.test-fixture'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

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

function tabCount(workspaceKey: string): number {
  return (useAppStore.getState().tabsByWorktree[workspaceKey] ?? []).length
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('the gated reseed that seeds an empty workspace in Electron', () => {
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

  // Use latest activation intent: stale explicit host constraints once rejected later history navigation and left no surface.
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

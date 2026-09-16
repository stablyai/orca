import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

type LifecycleMocks = {
  createTab: Mock<() => void>
  createWebRuntimeSessionTerminal: Mock<(...args: unknown[]) => unknown>
  newTerminalTabListener: null | (() => void)
  showClientCreationActionError: Mock<(...args: unknown[]) => unknown>
}

const mocks = vi.hoisted((): LifecycleMocks => ({
  createTab: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  newTerminalTabListener: null,
  showClientCreationActionError: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      activeWorktreeId: 'wt-1',
      createTab: mocks.createTab
    })
  }
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => 'runtime-1'
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: (...args: unknown[]) =>
    mocks.createWebRuntimeSessionTerminal(...args),
  isWebRuntimeSessionActive: () => true
}))

vi.mock('@/lib/client-creation-action-error', () => ({
  showClientCreationActionError: (...args: unknown[]) =>
    mocks.showClientCreationActionError(...args)
}))

vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: () => false
}))

import { registerTabLifecycleIpcBridge } from './tab-lifecycle-ipc-bridge'

describe('tab lifecycle IPC terminal creation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.newTerminalTabListener = null
    vi.stubGlobal('window', {
      api: {
        ui: new Proxy(
          {},
          {
            get: (_target, property) =>
              property === 'onNewTerminalTab'
                ? (listener: () => void) => {
                    mocks.newTerminalTabListener = listener
                    return () => {}
                  }
                : () => () => {}
          }
        )
      }
    })
  })

  it('reports the host message without creating a local fallback tab', async () => {
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({
      status: 'failed',
      message: 'host could not start the shell'
    })
    registerTabLifecycleIpcBridge([])

    mocks.newTerminalTabListener?.()

    await vi.waitFor(() =>
      expect(mocks.showClientCreationActionError).toHaveBeenCalledWith(
        'host could not start the shell'
      )
    )
    expect(mocks.createTab).not.toHaveBeenCalled()
  })

  it('reports rejected terminal creation without an unhandled promise', async () => {
    mocks.createWebRuntimeSessionTerminal.mockRejectedValue(new Error('runtime disconnected'))
    registerTabLifecycleIpcBridge([])

    mocks.newTerminalTabListener?.()

    await vi.waitFor(() =>
      expect(mocks.showClientCreationActionError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'runtime disconnected' })
      )
    )
    expect(mocks.createTab).not.toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createTab: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  newTerminalTabListener: null as null | (() => void),
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
})

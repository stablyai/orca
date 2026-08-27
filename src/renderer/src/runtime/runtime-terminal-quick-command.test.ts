import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  getActiveRuntimeTarget: vi.fn(),
  getSettingsForWorktreeRuntimeOwner: vi.fn(),
  state: { settings: {} }
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getSettingsForWorktreeRuntimeOwner: mocks.getSettingsForWorktreeRuntimeOwner
}))
vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc,
  getActiveRuntimeTarget: mocks.getActiveRuntimeTarget
}))

import { sendRuntimeTerminalQuickCommand } from './runtime-terminal-quick-command'

const leafId = 'd45db739-fb66-40d3-9533-d537772ad03f'

describe('sendRuntimeTerminalQuickCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getSettingsForWorktreeRuntimeOwner.mockReturnValue({
      activeRuntimeEnvironmentId: 'env-owner'
    })
    mocks.getActiveRuntimeTarget.mockReturnValue({
      kind: 'environment',
      environmentId: 'env-owner'
    })
  })

  it('resolves the exact pane on the worktree owner before sending Quick Command intent', async () => {
    mocks.callRuntimeRpc
      .mockResolvedValueOnce({
        terminal: {
          handle: 'terminal-1',
          tabId: 'tab-1',
          leafId,
          ptyId: 'pty-1',
          worktreeId: 'folder:workspace-1'
        }
      })
      .mockResolvedValueOnce({
        send: { handle: 'terminal-1', accepted: true, bytesWritten: 7 }
      })

    await expect(
      sendRuntimeTerminalQuickCommand({
        worktreeId: 'folder:workspace-1',
        tabId: 'tab-1',
        leafId,
        expectedPtyId: 'pty-1',
        text: 'echo x\r'
      })
    ).resolves.toBe(true)

    expect(mocks.getSettingsForWorktreeRuntimeOwner).toHaveBeenCalledWith(
      mocks.state,
      'folder:workspace-1'
    )
    expect(mocks.callRuntimeRpc).toHaveBeenNthCalledWith(
      1,
      { kind: 'environment', environmentId: 'env-owner' },
      'terminal.resolvePane',
      { paneKey: `tab-1:${leafId}`, worktreeId: 'folder:workspace-1' },
      { timeoutMs: 30_000 }
    )
    expect(mocks.callRuntimeRpc).toHaveBeenNthCalledWith(
      2,
      { kind: 'environment', environmentId: 'env-owner' },
      'terminal.send',
      {
        terminal: 'terminal-1',
        text: 'echo x\r',
        quickCommand: true,
        client: { id: 'orca-desktop', type: 'desktop' }
      },
      { timeoutMs: 30_000 }
    )
  })

  it('refuses a pane that rebound before the send', async () => {
    mocks.callRuntimeRpc.mockResolvedValueOnce({
      terminal: {
        handle: 'terminal-2',
        tabId: 'tab-1',
        leafId,
        ptyId: 'pty-replacement',
        worktreeId: 'worktree-1'
      }
    })

    await expect(
      sendRuntimeTerminalQuickCommand({
        worktreeId: 'worktree-1',
        tabId: 'tab-1',
        leafId,
        expectedPtyId: 'pty-original',
        text: 'echo x\r'
      })
    ).resolves.toBe(false)

    expect(mocks.callRuntimeRpc).toHaveBeenCalledOnce()
  })

  it('does not send when the transport binding changes after pane resolution', async () => {
    let current = true
    let releaseResolution!: () => void
    const paneResolved = new Promise<void>((resolve) => {
      releaseResolution = resolve
    })
    mocks.callRuntimeRpc.mockImplementationOnce(async () => {
      await paneResolved
      return {
        terminal: {
          handle: 'terminal-1',
          tabId: 'tab-1',
          leafId,
          ptyId: 'pty-1',
          worktreeId: 'worktree-1'
        }
      }
    })

    const isCurrent = vi.fn(() => current)
    const request = sendRuntimeTerminalQuickCommand({
      worktreeId: 'worktree-1',
      tabId: 'tab-1',
      leafId,
      expectedPtyId: 'pty-1',
      text: 'echo x\r',
      isCurrent
    })
    await vi.waitFor(() => expect(mocks.callRuntimeRpc).toHaveBeenCalledOnce())
    current = false
    releaseResolution()

    await expect(request).resolves.toBe(false)

    expect(isCurrent).toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).toHaveBeenCalledOnce()
  })
})

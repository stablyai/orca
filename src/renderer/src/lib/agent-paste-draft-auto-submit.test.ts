import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  inspectRuntimeTerminalProcess: vi.fn(),
  sendRuntimePtyInputVerified: vi.fn(),
  waitForAgentDraftInputReady: vi.fn()
}))

const appState = {
  settings: {},
  ptyIdsByTabId: { 'tab-1': ['pty-1'] },
  runtimePaneTitlesByTabId: {},
  tabsByWorktree: {},
  repos: [],
  worktreesByRepo: {}
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => appState,
    subscribe: () => vi.fn()
  }
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: vi.fn(() => false),
  inspectRuntimeTerminalProcess: mocks.inspectRuntimeTerminalProcess,
  sendRuntimePtyInputVerified: mocks.sendRuntimePtyInputVerified
}))

vi.mock('./agent-draft-readiness', () => ({
  waitForAgentDraftInputReady: mocks.waitForAgentDraftInputReady
}))

import { pasteDraftToAgentPtyWhenReady, pasteDraftWhenAgentReady } from './agent-paste-draft'

describe('agent draft auto-submit readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout
    })
    mocks.waitForAgentDraftInputReady.mockResolvedValue(false)
    mocks.inspectRuntimeTerminalProcess.mockResolvedValue({
      foregroundProcess: 'codex',
      hasChildProcesses: false
    })
  })

  it('fails closed when local Codex is running without a composer signal', async () => {
    const onTimeout = vi.fn()

    await expect(
      pasteDraftWhenAgentReady({
        tabId: 'tab-1',
        content: 'https://github.com/stablyai/orca/issues/7360',
        agent: 'codex',
        submit: true,
        forcePaste: true,
        onTimeout
      })
    ).resolves.toBe(false)

    expect(mocks.inspectRuntimeTerminalProcess).not.toHaveBeenCalled()
    expect(mocks.sendRuntimePtyInputVerified).not.toHaveBeenCalled()
    expect(onTimeout).toHaveBeenCalledOnce()
  })

  it('fails closed for runtime-owned PTY delivery without a composer signal', async () => {
    const onTimeout = vi.fn()

    await expect(
      pasteDraftToAgentPtyWhenReady({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        content: 'https://github.com/stablyai/orca/issues/7360',
        agent: 'codex',
        submit: true,
        forcePaste: true,
        onTimeout
      })
    ).resolves.toBe(false)

    expect(mocks.inspectRuntimeTerminalProcess).not.toHaveBeenCalled()
    expect(mocks.sendRuntimePtyInputVerified).not.toHaveBeenCalled()
    expect(onTimeout).toHaveBeenCalledOnce()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForAgentReady } from './agent-ready-wait'
import { useAppStore } from '@/store'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: vi.fn()
  }
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: vi.fn()
}))

vi.mock('@/lib/tui-agent-startup', () => ({
  isShellProcess: vi.fn(() => false)
}))

describe('waitForAgentReady', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { setTimeout })
    vi.mocked(useAppStore.getState).mockReturnValue({
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      runtimePaneTitlesByTabId: {},
      tabsByWorktree: {},
      settings: {}
    } as never)
  })

  it('recognizes a Windows foreground process reported as a full executable path', async () => {
    vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
      foregroundProcess: String.raw`C:\Users\dev\AppData\Roaming\npm\claude.exe`,
      hasChildProcesses: false
    })

    await expect(waitForAgentReady('tab-1', 'claude', { timeoutMs: 1 })).resolves.toEqual({
      ready: true,
      reason: 'foreground-match'
    })
  })
})

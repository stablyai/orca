// Exercises the desktop event, real startup queue and final IPC request together.
import { afterEach, expect, it, vi } from 'vitest'
import { createTestStore } from '../store/slices/store-test-helpers'
import { setupTerminalCreateSurfacing } from './ipc-events-terminal-create-test-harness'
import { spawnIpcPty } from '../components/terminal-pane/ipc-pty-spawn-request'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it.each(['presentation', 'request'] as const)(
  '%s create preserves profile selection through queue to PTY',
  async (bridge) => {
    const store = createTestStore()
    const scenario = await setupTerminalCreateSurfacing(() => false)
    scenario.queueTabStartupCommand.mockImplementation(store.getState().queueTabStartupCommand)
    const payload = {
      requestId: 'request-1',
      worktreeId: 'wt-1',
      command: 'codex',
      agentProfileId: 'profile-a'
    }
    if (bridge === 'presentation') {
      scenario.createTerminalListenerRef.current?.(payload)
    } else {
      scenario.requestTerminalCreateListenerRef.current?.(payload)
    }
    const pending = store.getState().consumeTabStartupCommand('tab-new')
    expect(pending).not.toBeNull()
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-profile' })
    vi.stubGlobal('window', { api: { pty: { spawn } } })
    await spawnIpcPty({ ...pending }, { url: '', callbacks: {} })
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ agentProfileId: 'profile-a' }))
  }
)

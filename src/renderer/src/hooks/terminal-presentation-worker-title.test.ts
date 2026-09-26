import { describe, expect, it } from 'vitest'
import { setupTerminalCreateSurfacing } from './ipc-events-terminal-create-test-harness'

describe('terminal presentation worker titles', () => {
  it('does not store an orchestration worker management title as a custom title', async () => {
    const scenario = await setupTerminalCreateSurfacing(() => false)
    const { createTerminalListenerRef, setTabCustomTitle } = scenario

    if (!createTerminalListenerRef.current) {
      throw new Error('Expected create-terminal listener to be registered')
    }

    createTerminalListenerRef.current({
      worktreeId: 'wt-2',
      ptyId: 'pty-worker',
      tabId: 'tab-worker',
      leafId: 'leaf-worker',
      title: 'worker-task_0123abcdef45',
      presentation: 'background'
    })

    expect(setTabCustomTitle).not.toHaveBeenCalled()
  })
})

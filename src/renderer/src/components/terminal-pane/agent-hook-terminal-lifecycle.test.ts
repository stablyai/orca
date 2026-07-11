import { describe, expect, it, vi } from 'vitest'
import {
  dispatchAgentHookTerminalLifecycle,
  registerAgentHookTerminalLifecycleHandler
} from './agent-hook-terminal-lifecycle'

describe('agent hook terminal lifecycle', () => {
  it('routes pane-scoped lifecycle events until unregister', () => {
    const handler = vi.fn()
    const unregister = registerAgentHookTerminalLifecycleHandler('tab-1:leaf-1', handler)

    dispatchAgentHookTerminalLifecycle('tab-1:leaf-1', {
      state: 'done',
      prompt: 'finish',
      agentType: 'codex'
    })
    unregister()
    dispatchAgentHookTerminalLifecycle('tab-1:leaf-1', {
      state: 'working',
      prompt: 'next',
      agentType: 'codex'
    })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'done', agentType: 'codex' })
    )
  })

  it('does not let stale unregister remove a replacement pane handler', () => {
    const staleHandler = vi.fn()
    const replacementHandler = vi.fn()
    const unregisterStale = registerAgentHookTerminalLifecycleHandler('tab-2:leaf-2', staleHandler)
    const unregisterReplacement = registerAgentHookTerminalLifecycleHandler(
      'tab-2:leaf-2',
      replacementHandler
    )

    unregisterStale()
    dispatchAgentHookTerminalLifecycle('tab-2:leaf-2', {
      state: 'blocked',
      prompt: 'approval',
      agentType: 'claude'
    })
    unregisterReplacement()

    expect(staleHandler).not.toHaveBeenCalled()
    expect(replacementHandler).toHaveBeenCalledTimes(1)
  })
})

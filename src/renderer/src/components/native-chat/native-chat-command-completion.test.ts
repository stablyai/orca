import { describe, expect, it, vi } from 'vitest'
import { afterNativeChatCommandSent } from './native-chat-command-completion'
import { createNativeChatPtySessionOptions } from './native-chat-pty-session-options'

describe('native chat resume command', () => {
  it.each(['codex', 'claude'] as const)(
    'opens the %s resume picker only after the final key is sent',
    async (agent) => {
      const openTerminal = vi.fn()
      const surface = createNativeChatPtySessionOptions({
        agent,
        scopeKey: `resume-${agent}`,
        mode: 'live',
        dispatchCommand: vi.fn(),
        onAgentPicker: openTerminal
      })
      const completion = Promise.withResolvers<void>()
      afterNativeChatCommandSent(
        { cancel: vi.fn(), settleAfterMs: 1, settled: completion.promise },
        () => surface?.recordOutgoingCommand('/resume')
      )
      expect(openTerminal).not.toHaveBeenCalled()
      completion.resolve()
      await completion.promise
      expect(openTerminal).toHaveBeenCalledTimes(1)
    }
  )

  it('does not switch a different pane when an in-flight command was cancelled', async () => {
    const completion = Promise.withResolvers<void>()
    const openTerminal = vi.fn()
    const cancel = vi.fn()
    const handle = afterNativeChatCommandSent(
      { cancel, settleAfterMs: 1, settled: completion.promise },
      openTerminal
    )
    handle.cancel()
    completion.resolve()
    await completion.promise
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(openTerminal).not.toHaveBeenCalled()
  })
})

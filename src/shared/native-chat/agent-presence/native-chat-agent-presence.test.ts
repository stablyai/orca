import { describe, expect, it } from 'vitest'
import {
  NATIVE_CHAT_AGENT_PRESENT,
  isNativeChatRestartNewConversation,
  nativeChatAgentExitWording,
  nextNativeChatAgentPresence
} from './native-chat-agent-presence'

describe('nextNativeChatAgentPresence', () => {
  it('latches an exit through unknown evidence and reports one restart when an agent returns', () => {
    const exited = nextNativeChatAgentPresence(NATIVE_CHAT_AGENT_PRESENT, {
      agentGone: true,
      agentRunning: false,
      exitCode: 137,
      sessionId: 'a',
      now: 10
    })
    expect(exited).toEqual({ exit: { at: 10, exitCode: 137, sessionId: 'a' }, restartFrom: null })
    // A shell command between exit and relaunch proves nothing either way.
    const unknown = { agentGone: false, agentRunning: false, sessionId: 'a', now: 20 }
    expect(nextNativeChatAgentPresence(exited, unknown)).toBe(exited)
    const restarted = nextNativeChatAgentPresence(exited, { ...unknown, agentRunning: true })
    expect(restarted).toEqual({ exit: null, restartFrom: { sessionId: 'a' } })
    expect(isNativeChatRestartNewConversation(restarted.restartFrom, 'b')).toBe(true)
    expect(isNativeChatRestartNewConversation(restarted.restartFrom, 'a')).toBe(false)
  })

  it('names SIGKILL as a kill and other signal deaths by signal', () => {
    expect(nativeChatAgentExitWording(137)).toEqual({ kind: 'killed', code: 137 })
    expect(nativeChatAgentExitWording(143)).toEqual({
      kind: 'signal',
      code: 143,
      signal: 'SIGTERM'
    })
    expect(nativeChatAgentExitWording(1)).toEqual({ kind: 'code', code: 1 })
  })
})

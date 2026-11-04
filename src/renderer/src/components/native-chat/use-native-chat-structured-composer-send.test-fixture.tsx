import { renderHook } from '@testing-library/react'
import { vi, type Mock } from 'vitest'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../shared/agent-session/view/structured-agent-session-composer'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import {
  useNativeChatStructuredComposerSend,
  type NativeChatStructuredComposerSend,
  type UseNativeChatStructuredComposerSendArgs
} from './use-native-chat-structured-composer-send'

export const ATTACHMENT: NativeChatComposerImageAttachment = { id: 'a1', path: '/tmp/shot.png' }

type NativeChatStructuredComposerSendHarness = {
  send: NativeChatStructuredComposerSend
  structuredTransport: NativeChatStructuredComposerTransport
  setDraft: Mock<UseNativeChatStructuredComposerSendArgs['setDraft']>
}

export function harness(
  agent: AgentType,
  threadGoal?: NativeChatStructuredComposerTransport['threadGoal'],
  onSubmitted?: () => void
): NativeChatStructuredComposerSendHarness {
  const structuredTransport: NativeChatStructuredComposerTransport = {
    capturePresentation: () => () => true,
    steerCapability: 'supported',
    send: vi.fn(() => true),
    dispatchCommand: (text: string) =>
      dispatchStructuredAgentSessionComposerCommand(text, {
        agent,
        sessionCommands: structuredTransport.sessionCommands,
        snapshot: [],
        invokeAction: async () => true,
        setOption: async () => true,
        conversationCommands: ['clear', 'compact'],
        runConversationCommand: async () => ({ accepted: true, error: null })
      }),
    optionsSurface: {
      getSnapshot: () => [],
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      subscribe: () => () => {}
    },
    optionSnapshot: [],
    onError: vi.fn(),
    runtime: 'local',
    sessionId: 'session-test',
    runtimeEnvironmentId: null
  }
  if (threadGoal) {
    structuredTransport.threadGoal = threadGoal
  }
  structuredTransport.onSubmitted = onSubmitted
  const setDraft = vi.fn<UseNativeChatStructuredComposerSendArgs['setDraft']>()
  const { result } = renderHook(() =>
    useNativeChatStructuredComposerSend({
      agent,
      draftScopeKey: 'tab-1:pane',
      imageAttachments: [ATTACHMENT],
      structuredTransport,
      isComposing: () => false,
      clearSkillOrigin: vi.fn(),
      setDraft,
      setCaret: vi.fn()
    })
  )
  return { send: result.current, structuredTransport, setDraft }
}

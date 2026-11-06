import { renderHook } from '@testing-library/react'
import { vi, type Mock } from 'vitest'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
export const STRUCTURED_COMPOSER_SEND_ATTACHMENT: NativeChatComposerImageAttachment = {
  id: 'a1',
  path: '/tmp/shot.png'
}
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../shared/agent-session/view/structured-agent-session-composer'
import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'

export function structuredComposerSendHarness(
  agent: AgentType,
  threadGoal?: NativeChatStructuredComposerTransport['threadGoal'],
  onSubmitted?: () => void
): {
  send: ReturnType<typeof useNativeChatStructuredComposerSend>
  structuredTransport: NativeChatStructuredComposerTransport
  setDraft: Mock<(draft: string) => void>
} {
  const structuredTransport: NativeChatStructuredComposerTransport = {
    capturePresentation: () => () => true,
    send: vi.fn(() => true),
    dispatchCommand: (text, skills) =>
      dispatchStructuredAgentSessionComposerCommand(
        text,
        {
          agent,
          sessionCommands: structuredTransport.sessionCommands,
          snapshot: [],
          invokeAction: async () => true,
          setOption: async () => true,
          conversationCommands: ['clear', 'compact'],
          runConversationCommand: async () => ({ accepted: true, error: null }),
          openSideChat: structuredTransport.openSideChat
        },
        skills
      ),
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
  const setDraft = vi.fn()
  const { result } = renderHook(() =>
    useNativeChatStructuredComposerSend({
      agent,
      draftScopeKey: 'tab-1:pane',
      imageAttachments: [STRUCTURED_COMPOSER_SEND_ATTACHMENT],
      structuredTransport,
      isComposing: () => false,
      clearSkillOrigin: vi.fn(),
      setDraft,
      setCaret: vi.fn()
    })
  )
  return { send: result.current, structuredTransport, setDraft }
}

import { NativeChatPendingAsyncQuestions } from './NativeChatPendingAsyncQuestions'
import { useLayoutEffect, useMemo, useRef, type ContextType, type ReactNode } from 'react'
import { reportStructuredSessionUserInput } from '@/lib/worker-terminal-takeover-report'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import { NativeChatAsyncQuestionContext } from './native-chat-async-question-context'
import { NativeChatRewindContext } from './native-chat-rewind-context'
import { NativeChatOrcaStopContext } from './native-chat-orca-stop-context'
import { NativeChatClaudeSignInContext } from './native-chat-claude-sign-in'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'

/** Shares reply controls without rerendering every message row on each streamed update. */
export function NativeChatStructuredMessageProviders({
  controller,
  pane,
  blocked,
  installBlocked,
  continuation,
  claudeSignIn,
  onSubmitted,
  children
}: {
  controller: ReturnType<typeof useStructuredAgentSession>
  pane: Pick<NativeChatStructuredViewProps, 'sessionId' | 'target'>
  blocked: boolean
  installBlocked: boolean
  continuation: ContextType<typeof NativeChatOrcaStopContext>
  claudeSignIn: ContextType<typeof NativeChatClaudeSignInContext>
  onSubmitted: () => void
  children: ReactNode
}): React.JSX.Element {
  const { send, sendOut, prompts, rewind, pendingAsyncQuestions } = controller
  const { sessionId, target } = pane
  const disabled = blocked || installBlocked || sendOut || prompts.length > 0
  const runtimeEnvironmentId = target.kind === 'local' ? null : (target.environmentId ?? null)
  const latest = useRef({ send, onSubmitted, disabled })
  useLayoutEffect(() => {
    latest.current = { send, onSubmitted, disabled }
  }, [send, onSubmitted, disabled])
  const value = useMemo(
    () => ({
      disabled,
      pendingQuestions: pendingAsyncQuestions,
      send: (text: string): boolean => {
        const current = latest.current
        if (disabled || current.disabled || !current.send(text, [], { immediate: true })) {
          return false
        }
        current.onSubmitted()
        reportStructuredSessionUserInput(sessionId, runtimeEnvironmentId)
        return true
      }
    }),
    [disabled, sessionId, runtimeEnvironmentId, pendingAsyncQuestions]
  )
  return (
    <NativeChatAsyncQuestionContext.Provider value={value}>
      <NativeChatRewindContext.Provider value={rewind.surface}>
        <NativeChatOrcaStopContext.Provider value={continuation}>
          <NativeChatClaudeSignInContext.Provider value={claudeSignIn}>
            {children}
            <NativeChatPendingAsyncQuestions />
          </NativeChatClaudeSignInContext.Provider>
        </NativeChatOrcaStopContext.Provider>
      </NativeChatRewindContext.Provider>
    </NativeChatAsyncQuestionContext.Provider>
  )
}

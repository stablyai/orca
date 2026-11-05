import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentSessionAccountUsage } from '../../../../shared/agent-session/agent-session-account-usage'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { NativeChatAccountUsageCard } from './NativeChatAccountUsageCard'

export function useNativeChatAccountUsage(args: {
  supported: boolean
  sessionId: string
  target: RuntimeClientTarget
  fence: number | null
  turnId: string | null
  /** The approval or question waiting on the person; answering or raising one resumes work. */
  promptId: string | null
}) {
  const { sessionId, target, supported, fence, turnId, promptId } = args
  const identity = `${target.kind === 'local' ? 'local' : target.environmentId}:${sessionId}:${fence}`
  const [panel, setPanel] = useState<{
    /** Which `/usage` opening this panel belongs to; late replies for any other are dropped. */
    request: number
    identity: string
    turnId: string | null
    promptId: string | null
    result: AgentSessionAccountUsage | null
    /** A reset's outcome, kept across the refresh it triggers. */
    notice: string | null
  } | null>(null)
  const nextRequest = useRef(0)
  // The committed panel's request, for callbacks that outlive it (a reset finishing after dismissal).
  const shownRequest = useRef<number | null>(null)
  useEffect(() => {
    shownRequest.current = panel?.request ?? null
    // Unmounting retires callbacks that outlive the chat (a reset finishing later).
    return () => {
      shownRequest.current = null
    }
  }, [panel])
  const dismiss = useCallback(() => setPanel(null), [])
  if (
    panel !== null &&
    (panel.identity !== identity ||
      (turnId !== null && panel.turnId !== turnId) ||
      panel.promptId !== promptId)
  ) {
    setPanel(null)
  }
  const open = useCallback(
    async (notice: string | null = null) => {
      const request = ++nextRequest.current
      setPanel({ request, identity, turnId, promptId, result: null, notice })
      const result = await callStructuredAgentSession<AgentSessionAccountUsage>(
        target,
        'agentSession.accountUsage',
        { sessionId }
      ).catch(() => ({ status: 'failed' as const }))
      setPanel((current) => (current?.request === request ? { ...current, result } : current))
    },
    [identity, sessionId, target, turnId, promptId]
  )
  return {
    command: supported
      ? {
          open: () => {
            void open()
          }
        }
      : undefined,
    card:
      supported && panel?.identity === identity ? (
        <NativeChatAccountUsageCard
          result={panel.result}
          notice={panel.notice}
          target={target}
          onDismiss={dismiss}
          onRetry={(notice) => {
            if (shownRequest.current === panel.request) {
              void open(notice)
            }
          }}
        />
      ) : null
  }
}

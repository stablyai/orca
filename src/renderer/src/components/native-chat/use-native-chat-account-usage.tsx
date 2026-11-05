import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentSessionAccountUsage } from '../../../../shared/agent-session/agent-session-account-usage'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { NativeChatAccountUsageCard } from './NativeChatAccountUsageCard'
import { useNativeChatUsageResetAuthority } from './use-native-chat-usage-reset-authority'

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
    /** Which `/usage` opening this panel is; callbacks from any other are dropped. */
    opening: number
    /** The newest read for this panel; late replies to older ones are dropped. */
    request: number
    identity: string
    turnId: string | null
    promptId: string | null
    result: AgentSessionAccountUsage | null
    /** A reset's outcome, kept across the refresh it triggers. */
    notice: string | null
  } | null>(null)
  const nextRequest = useRef(0)
  // The committed panel's opening, for callbacks that outlive it (a reset finishing after dismissal).
  const shownOpening = useRef<number | null>(null)
  useEffect(() => {
    shownOpening.current = panel?.opening ?? null
    // Unmounting retires callbacks that outlive the chat (a reset finishing later).
    return () => {
      shownOpening.current = null
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
      setPanel({ opening: request, request, identity, turnId, promptId, result: null, notice })
      const result = await callStructuredAgentSession<AgentSessionAccountUsage>(
        target,
        'agentSession.accountUsage',
        { sessionId }
      ).catch(() => ({ status: 'failed' as const }))
      setPanel((current) => (current?.request === request ? { ...current, result } : current))
    },
    [identity, sessionId, target, turnId, promptId]
  )
  // The host builds the reset offer from its own Codex state, which can land after the card
  // opened (its first read after launch, an account switch); re-read when it changes.
  const authority = useNativeChatUsageResetAuthority(target, panel?.result?.status === 'ok')
  const seenAuthority = useRef<string | null>(null)
  useEffect(() => {
    const previous = seenAuthority.current
    seenAuthority.current = authority
    if (authority === null || previous === null || previous === authority) {
      return
    }
    const request = ++nextRequest.current
    setPanel((current) => (current ? { ...current, request } : current))
    void callStructuredAgentSession<AgentSessionAccountUsage>(target, 'agentSession.accountUsage', {
      sessionId
    })
      .catch(() => null)
      .then((result) =>
        // A failed background read keeps what the card already shows.
        setPanel((current) =>
          current?.request === request && result?.status === 'ok' ? { ...current, result } : current
        )
      )
  }, [authority, sessionId, target])
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
            if (shownOpening.current === panel.opening) {
              void open(notice)
            }
          }}
        />
      ) : null
  }
}

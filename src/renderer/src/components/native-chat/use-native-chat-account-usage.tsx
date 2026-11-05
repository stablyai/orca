import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentSessionAccountUsage } from '../../../../shared/agent-session/agent-session-account-usage'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { NativeChatAccountUsageCard } from './NativeChatAccountUsageCard'
import {
  CODEX_RESET_AUTHORITY_READING,
  useNativeChatUsageResetAuthority
} from './use-native-chat-usage-reset-authority'

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
  // Watched from the opening, so a change during the first read is not mistaken for its baseline.
  const watching = panel !== null
  const authority = useNativeChatUsageResetAuthority(target, watching)
  const seenAuthority = useRef<string | null>(null)
  const resultShown = useRef(false)
  useEffect(() => {
    resultShown.current = panel?.result != null
  }, [panel])
  // One background read per opening at a time; changes during it collapse into one follow-up.
  // The read belongs to its opening: retiring the card (dismissal, chat or turn change, unmount)
  // stops its follow-up and drops its reply.
  const reconciling = useRef<{ opening: number; again: boolean } | null>(null)
  const reconcile = useCallback(
    (opening: number) => {
      if (reconciling.current?.opening === opening) {
        reconciling.current.again = true
        return
      }
      reconciling.current = { opening, again: false }
      const request = ++nextRequest.current
      setPanel((current) => (current?.opening === opening ? { ...current, request } : current))
      void callStructuredAgentSession<AgentSessionAccountUsage>(
        target,
        'agentSession.accountUsage',
        { sessionId }
      )
        .catch(() => null)
        .then((result) => {
          // A failed background read keeps what the card shows; a card still loading shows it.
          setPanel((current) =>
            current?.opening === opening &&
            current.request === request &&
            (result?.status === 'ok' || current.result === null)
              ? { ...current, result: result ?? { status: 'failed' } }
              : current
          )
          const run = reconciling.current
          if (run?.opening !== opening) {
            return
          }
          reconciling.current = null
          if (run.again && shownOpening.current === opening) {
            reconcile(opening)
          }
        })
    },
    [sessionId, target]
  )
  useEffect(() => {
    if (!watching) {
      seenAuthority.current = null
      reconciling.current = null
    }
  }, [watching])
  useEffect(() => {
    if (authority === null) {
      return
    }
    const previous = seenAuthority.current
    seenAuthority.current = authority
    // A host still reading has nothing new yet; its finished read is the change worth a re-read.
    if (authority === CODEX_RESET_AUTHORITY_READING || previous === authority) {
      return
    }
    // A first observation after the reply may postdate the state the host built the offer from.
    const opening = shownOpening.current
    if (opening !== null && (previous !== null || resultShown.current)) {
      reconcile(opening)
    }
  }, [authority, reconcile])
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

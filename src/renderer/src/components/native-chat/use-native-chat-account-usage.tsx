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
}) {
  const { sessionId, target, supported, fence, turnId } = args
  const identity = `${target.kind === 'local' ? 'local' : target.environmentId}:${sessionId}:${fence}`
  const [panel, setPanel] = useState<{
    identity: string
    turnId: string | null
    result: AgentSessionAccountUsage | null
    /** A reset's outcome, kept across the refresh it triggers. */
    notice: string | null
  } | null>(null)
  const revision = useRef(0)
  const dismiss = useCallback(() => {
    revision.current++
    setPanel(null)
  }, [])
  if (
    panel !== null &&
    (panel.identity !== identity || (turnId !== null && panel.turnId !== turnId))
  ) {
    revision.current++
    setPanel(null)
  }
  useEffect(
    () => () => {
      revision.current++
    },
    []
  )
  const open = useCallback(
    async (notice: string | null = null) => {
      const request = ++revision.current
      setPanel({ identity, turnId, result: null, notice })
      const result = await callStructuredAgentSession<AgentSessionAccountUsage>(
        target,
        'agentSession.accountUsage',
        { sessionId }
      ).catch(() => ({ status: 'failed' as const }))
      if (revision.current === request) {
        setPanel({ identity, turnId, result, notice })
      }
    },
    [identity, sessionId, target, turnId]
  )
  const panelRevision = revision.current
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
            if (revision.current === panelRevision) {
              void open(notice)
            }
          }}
        />
      ) : null
  }
}

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
  sending: boolean
}) {
  const { sessionId, target, supported, fence, turnId, sending } = args
  const identity = `${target.kind === 'local' ? 'local' : target.environmentId}:${sessionId}:${fence}`
  const [panel, setPanel] = useState<{
    identity: string
    result: AgentSessionAccountUsage | null
  } | null>(null)
  const revision = useRef(0)
  const dismiss = useCallback(() => {
    revision.current++
    setPanel(null)
  }, [])
  if (panel !== null && panel.identity !== identity) {
    revision.current++
    setPanel(null)
  }
  useEffect(
    () => () => {
      revision.current++
    },
    []
  )
  useEffect(() => {
    if (turnId !== null || sending) {
      dismiss()
    }
  }, [turnId, sending, dismiss])
  const open = useCallback(async () => {
    const request = ++revision.current
    setPanel({ identity, result: null })
    const result = await callStructuredAgentSession<AgentSessionAccountUsage>(
      target,
      'agentSession.accountUsage',
      { sessionId }
    ).catch(() => ({ status: 'failed' as const }))
    if (revision.current === request) {
      setPanel({ identity, result })
    }
  }, [identity, sessionId, target])
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
          target={target}
          onDismiss={dismiss}
          onRetry={() => {
            if (revision.current === panelRevision) {
              void open()
            }
          }}
        />
      ) : null
  }
}

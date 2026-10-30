import { useMemo, useRef, useState } from 'react'
import { AGENT_SESSION_CODEX_FORK_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import { useStructuredAgentSessionHostCapability } from '@/runtime/structured-agent-session-host-capability'
import { executionHostIdForStructuredTarget } from '@/runtime/structured-agent-session-owner'
import { startStructuredAgentLaunch } from '@/lib/structured-agent-session-launch'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { captureStructuredLaunchSurfaceAddress } from '@/lib/structured-agent-session-launch-surface'
import { nativeChatForkEligibleItemIds } from './native-chat-fork-eligibility'
import type { NativeChatForkSurface } from './native-chat-fork-context'
import { translate } from '@/i18n/i18n'

export function useNativeChatFork({
  pane,
  worktreeId,
  epoch,
  items,
  ready
}: {
  pane: Pick<NativeChatStructuredViewProps, 'agent' | 'sessionId' | 'target' | 'groupId'>
  worktreeId: string | null | undefined
  epoch: string | null
  items: readonly AgentJournalRenderItem[]
  ready: boolean
}): { surface: NativeChatForkSurface | undefined; error: string | null } {
  const supported = useStructuredAgentSessionHostCapability(
    pane.target,
    AGENT_SESSION_CODEX_FORK_RUNTIME_CAPABILITY
  )
  const eligibleItemIds = useMemo(() => nativeChatForkEligibleItemIds(items), [items])
  const inFlight = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const surface = useMemo<NativeChatForkSurface | undefined>(() => {
    if (pane.agent !== 'codex' || !supported || !worktreeId || !epoch || !ready) {
      return undefined
    }
    return {
      eligibleItemIds,
      pending,
      request: async (itemId) => {
        if (inFlight.current || !eligibleItemIds.has(itemId)) {
          return
        }
        inFlight.current = true
        setPending(true)
        setError(null)
        try {
          const launch = startStructuredAgentLaunch(worktreeId, 'codex', {
            requestId: newAgentLaunchRequestId(),
            executionHostId: executionHostIdForStructuredTarget(pane.target),
            forkFrom: { sessionId: pane.sessionId, itemId, expectedEpoch: epoch },
            surfaceAddress: captureStructuredLaunchSurfaceAddress(worktreeId, pane.groupId)
          })
          await launch.launchResult
        } catch (cause) {
          setError(
            cause instanceof Error
              ? cause.message
              : translate(
                  'components.native-chat.fork.failed',
                  'The branch could not be confirmed. Check the new chat before trying again.'
                )
          )
        } finally {
          inFlight.current = false
          setPending(false)
        }
      }
    }
  }, [
    pane.agent,
    pane.sessionId,
    pane.target,
    pane.groupId,
    supported,
    worktreeId,
    epoch,
    ready,
    eligibleItemIds,
    pending
  ])
  return { surface, error }
}

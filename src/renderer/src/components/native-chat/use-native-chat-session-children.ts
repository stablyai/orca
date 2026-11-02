import { createCoalescedPollRunner } from '../right-sidebar/coalesced-poll-runner'
import { useAppStore } from '@/store'
import { useEffect, useMemo, useState } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  ORCHESTRATION_SESSION_CHILDREN_CAPABILITY,
  type OrchestrationSessionChild,
  type OrchestrationSessionChildren
} from '../../../../shared/orchestration-session-children'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'

function workerLifecycleKey(state: ReturnType<typeof useAppStore.getState>): string {
  return JSON.stringify(
    Object.entries(state.agentStatusByPaneKey).flatMap(([key, row]) =>
      row.orchestration
        ? [
            [
              key,
              row.orchestration.dispatchId,
              row.orchestration.dispatchStatus,
              row.state,
              row.providerSession
            ]
          ]
        : []
    )
  )
}

export function useNativeChatSessionChildren(args: {
  sessionId: string
  target: RuntimeClientTarget
  dispatchId?: string
  enabled: boolean
}) {
  const { sessionId, dispatchId, enabled } = args
  const environmentId = args.target.kind === 'environment' ? args.target.environmentId : null
  const target = useMemo<RuntimeClientTarget>(
    () => (environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }),
    [environmentId]
  )
  const capability = useStructuredAgentSessionHostCapabilityState(
    enabled ? target : null,
    ORCHESTRATION_SESSION_CHILDREN_CAPABILITY
  )
  const key = JSON.stringify([target, sessionId, dispatchId])
  const [snapshot, setSnapshot] = useState<{
    key: string
    children: OrchestrationSessionChild[]
    current: boolean
  } | null>(null)
  useEffect(() => {
    if (!enabled || capability !== 'supported') {
      return
    }
    let disposed = false
    const refresh = async (): Promise<void> => {
      try {
        const children: OrchestrationSessionChild[] = []
        const visited = new Set<string>()
        let cursor: string | null = null
        do {
          const page: OrchestrationSessionChildren = await callRuntimeRpc(
            target,
            'orchestration.sessionChildren',
            {
              sessionId,
              ...(dispatchId ? { dispatchId } : {}),
              ...(cursor ? { cursor } : {})
            }
          )
          if (disposed) {
            return
          }
          children.push(...page.children)
          cursor = page.nextCursor
          if (cursor && visited.has(cursor)) {
            throw new Error('Repeated child history cursor')
          }
          if (cursor) {
            visited.add(cursor)
          }
        } while (cursor !== null)
        setSnapshot({ key, children, current: true })
      } catch {
        if (disposed) {
          return
        }
        setSnapshot((old) => ({
          key,
          children: old?.key === key ? old.children : [],
          current: false
        }))
      }
    }
    const runner = createCoalescedPollRunner(refresh, { minIntervalMs: 250 })
    runner.run()
    let lifecycle = workerLifecycleKey(useAppStore.getState())
    const unsubscribe = useAppStore.subscribe((state) => {
      const next = workerLifecycleKey(state)
      if (next === lifecycle) {
        return
      }
      lifecycle = next
      runner.run({ changeSignal: true })
    })
    // Status pushes drive updates; recover missed events from older hosts at a coarse interval.
    const timer = setInterval(() => runner.run(), 30_000)
    return () => {
      disposed = true
      clearInterval(timer)
      unsubscribe()
      runner.dispose()
    }
  }, [capability, dispatchId, enabled, key, sessionId, target])
  const current = enabled && capability === 'supported' && snapshot?.key === key && snapshot.current
  return {
    children: snapshot?.key === key ? snapshot.children : [],
    current,
    loading: enabled && capability === 'supported' && snapshot?.key !== key
  }
}

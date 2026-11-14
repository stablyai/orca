import { useEffect } from 'react'
import type { ExecutionHostScope } from '../../../../../../shared/execution-host'
import {
  parseRoutableExecutionHostId,
  requestedExecutionHostScope
} from '../../../../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import { useAppStore } from '@/store'

/** Names and new journal identities change independently of provider files and tab visibility. */
export function useAiVaultConversationRefresh(
  enabled: boolean,
  executionHostScope: ExecutionHostScope,
  refresh: (args: { background: boolean }) => Promise<void>
): void {
  const environmentsKey = useAppStore((state) =>
    enabled
      ? state.runtimeEnvironments
          .map((environment) => environment.id)
          .sort()
          .join('\n')
      : ''
  )
  useEffect(() => {
    if (!enabled) {
      return
    }
    const scope = requestedExecutionHostScope(executionHostScope)
    const parsed = parseRoutableExecutionHostId(scope)
    const targets: RuntimeClientTarget[] =
      scope === 'all'
        ? [
            { kind: 'local' },
            ...environmentsKey
              .split('\n')
              .filter(Boolean)
              .map((environmentId) => ({ kind: 'environment' as const, environmentId }))
          ]
        : parsed?.kind === 'runtime'
          ? [{ kind: 'environment', environmentId: parsed.environmentId }]
          : scope === 'local'
            ? [{ kind: 'local' }]
            : []
    const dispose = targets.map((target) => observeConversationCatalogChanges(target, refresh))
    return () => {
      for (const close of dispose) {
        close()
      }
    }
  }, [enabled, environmentsKey, executionHostScope, refresh])
}

function observeConversationCatalogChanges(
  target: RuntimeClientTarget,
  refresh: (args: { background: boolean }) => Promise<void>
): () => void {
  const feed = getStructuredAgentSessionStatusFeed(target)
  let previous = '[]'
  const changed = (): void => {
    const key = JSON.stringify(
      [...feed.getSnapshot().values()].map((session) => [
        session.sessionId,
        session.conversationName,
        session.providerSession?.id,
        session.status,
        session.status === 'working' ? undefined : session.updatedAt
      ])
    )
    if (key === previous) {
      return
    }
    previous = key
    void refresh({ background: true })
  }
  const unsubscribe = feed.subscribe(changed)
  const deactivate = feed.activate()
  changed()
  return () => {
    unsubscribe()
    deactivate()
  }
}

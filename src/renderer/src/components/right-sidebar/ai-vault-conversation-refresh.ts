import { useEffect, useRef } from 'react'
import type { ExecutionHostScope } from '../../../../shared/execution-host'
import {
  parseRoutableExecutionHostId,
  requestedExecutionHostScope
} from '../../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import { useAppStore } from '@/store'
import { getAgentSessionIdsKey } from './ai-vault-agent-session-refresh-key'

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

/** Native chat identities use the catalog feed; terminal IDs still discover provider files. */
export function useAiVaultProviderSessionRefresh(
  terminalOnly: boolean,
  requestForcedRescan: () => void
): void {
  const key = useAppStore((state) =>
    getAgentSessionIdsKey(state.agentStatusByPaneKey, terminalOnly)
  )
  const seenRef = useRef<Set<string> | null>(null)
  useEffect(() => {
    const ids = key === '' ? [] : key.split('\n')
    if (seenRef.current === null) {
      seenRef.current = new Set(ids)
      return
    }
    const seen = seenRef.current
    const fresh = ids.filter((id) => !seen.has(id))
    if (fresh.length === 0) {
      return
    }
    for (const id of fresh) {
      seen.add(id)
    }
    requestForcedRescan()
  }, [key, requestForcedRescan])
}

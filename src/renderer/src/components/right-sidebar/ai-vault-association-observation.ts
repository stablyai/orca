import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import {
  type ExecutionHostScope,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import { invalidateAiVaultSessionResults } from './ai-vault-session-result-cache'

/** List and search activate the same host feeds, independently of open chat tabs. */
export function useAiVaultAssociationObservation(scope: ExecutionHostScope | null) {
  const environments = useAppStore((s) => s.runtimeEnvironments) ?? []
  const addressed = environments.find((e) => toRuntimeExecutionHostId(e.id) === scope)
  const identity = JSON.stringify(
    scope === 'all'
      ? [
          'local',
          ...environments.map((e) => [
            toRuntimeExecutionHostId(e.id),
            e.runtimeId,
            e.pairingRevision ?? e.createdAt
          ])
        ]
      : [scope, addressed?.runtimeId, addressed?.pairingRevision ?? addressed?.createdAt]
  )
  return useMemo(() => {
    const hosts: ExecutionHostScope[] =
      scope === 'all'
        ? ['local', ...environments.map((e) => toRuntimeExecutionHostId(e.id))]
        : scope
          ? [scope]
          : []
    const feeds = hosts.flatMap((host) => {
      const target = structuredAgentSessionTargetForHost(host)
      return target ? [{ host, feed: getStructuredAgentSessionStatusFeed(target) }] : []
    })
    return {
      getSnapshot: () =>
        JSON.stringify([identity, ...feeds.map(({ feed }) => feed.getAssociationRevision())]),
      subscribe: (listener: () => void) => {
        const stops = feeds.map(({ host, feed }) => {
          let revision = feed.getAssociationRevision()
          const stop = feed.subscribe(() => {
            const next = feed.getAssociationRevision()
            if (revision === next) {
              return
            }
            revision = next
            invalidateAiVaultSessionResults(host)
            listener()
          })
          const deactivate = feed.activate()
          return () => {
            stop()
            deactivate()
          }
        })
        return () => stops.forEach((stop) => stop())
      }
    }
    // The addressed identity, rather than unrelated catalog metadata, owns this observation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity])
}

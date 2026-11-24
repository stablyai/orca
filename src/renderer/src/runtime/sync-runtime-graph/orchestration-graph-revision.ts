import type { AppState } from '@/store/types'
import { graphState } from './graph-state'
import type { RuntimeSyncWindowGraphResult } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

type Contexts = AppState['runtimeAgentOrchestrationByPaneKey']

/** The map main last sent and its revision; a local edit to the map voids it. */
let applied: { revision: number; contexts: Contexts } | null = null

export function appliedOrchestrationRevision(state: AppState): number | undefined {
  return applied && applied.contexts === state.runtimeAgentOrchestrationByPaneKey
    ? applied.revision
    : undefined
}

/** An unchanged reply still re-applies the held map, merging it into status rows that arrived since. */
export function applyOrchestrationReply(
  current: AppState | null | undefined,
  sent: AppState,
  base: number | undefined,
  result: RuntimeSyncWindowGraphResult | undefined
): void {
  const revision = result?.agentOrchestrationRevision
  const unchanged = revision !== undefined && revision === base
  const held = current?.runtimeAgentOrchestrationByPaneKey
  current?.setRuntimeAgentOrchestrationByPaneKey?.(
    unchanged && held ? held : (result?.agentOrchestrationByPaneKey ?? {})
  )
  const contexts = graphState.getStoreState?.()?.runtimeAgentOrchestrationByPaneKey
  applied =
    revision !== undefined &&
    contexts &&
    (!unchanged || held === sent.runtimeAgentOrchestrationByPaneKey)
      ? { revision, contexts }
      : null
}

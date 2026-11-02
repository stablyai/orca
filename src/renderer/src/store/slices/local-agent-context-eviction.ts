import type { AppState } from '../types'

type LocalAgentContextState = Pick<
  AppState,
  | 'detectedAgentIds'
  | 'isDetectingAgents'
  | 'isRefreshingAgents'
  | 'localDetectedAgentIdsByContext'
  | 'isDetectingLocalAgentsByContext'
  | 'isRefreshingLocalAgentsByContext'
  | 'pathSource'
  | 'pathFailureReason'
>

export type LocalAgentContextEviction = {
  removedContextKeys: ReadonlySet<string>
  detectedContextKey: string | null
  legacyDetectContextKey: string | null
  legacyRefreshContextKey: string | null
  statePatch: Partial<LocalAgentContextState>
}

export function removeLocalAgentContextEntries<T>(
  entries: Record<string, T>,
  contextKeys: ReadonlySet<string>
): Record<string, T> {
  let filtered = entries
  for (const contextKey of contextKeys) {
    if (!(contextKey in filtered)) {
      continue
    }
    if (filtered === entries) {
      filtered = { ...entries }
    }
    delete filtered[contextKey]
  }
  return filtered
}

export function removeLocalAgentContextEntry<T>(entries: Record<string, T>, contextKey: string) {
  return removeLocalAgentContextEntries(entries, new Set([contextKey]))
}

export function getLocalAgentContextEviction(args: {
  projectIds: readonly string[]
  state: LocalAgentContextState
  internalContextKeys: Iterable<string>
  detectedContextKey: string | null
  legacyDetectContextKey: string | null
  legacyRefreshContextKey: string | null
}): LocalAgentContextEviction | null {
  const prefixes = args.projectIds
    .map((projectId) => projectId.trim())
    .filter(Boolean)
    .map((projectId) => `${projectId}:`)
  if (prefixes.length === 0) {
    return null
  }
  const contextKeys = new Set([
    ...Object.keys(args.state.localDetectedAgentIdsByContext),
    ...Object.keys(args.state.isDetectingLocalAgentsByContext),
    ...Object.keys(args.state.isRefreshingLocalAgentsByContext),
    ...args.internalContextKeys
  ])
  const removedContextKeys = new Set(
    [...contextKeys].filter((contextKey) =>
      prefixes.some((prefix) => contextKey.startsWith(prefix))
    )
  )
  if (removedContextKeys.size === 0) {
    return null
  }
  const clearDetected = Boolean(
    (args.detectedContextKey && removedContextKeys.has(args.detectedContextKey)) ||
    (args.legacyDetectContextKey && removedContextKeys.has(args.legacyDetectContextKey))
  )
  const clearRefreshing = Boolean(
    args.legacyRefreshContextKey && removedContextKeys.has(args.legacyRefreshContextKey)
  )
  return {
    removedContextKeys,
    detectedContextKey:
      args.detectedContextKey && removedContextKeys.has(args.detectedContextKey)
        ? null
        : args.detectedContextKey,
    legacyDetectContextKey:
      args.legacyDetectContextKey && removedContextKeys.has(args.legacyDetectContextKey)
        ? null
        : args.legacyDetectContextKey,
    legacyRefreshContextKey:
      args.legacyRefreshContextKey && removedContextKeys.has(args.legacyRefreshContextKey)
        ? null
        : args.legacyRefreshContextKey,
    statePatch: {
      ...(clearDetected
        ? {
            detectedAgentIds: null,
            isDetectingAgents: false,
            pathSource: null,
            pathFailureReason: null
          }
        : {}),
      ...(clearRefreshing ? { isRefreshingAgents: false } : {}),
      localDetectedAgentIdsByContext: removeLocalAgentContextEntries(
        args.state.localDetectedAgentIdsByContext,
        removedContextKeys
      ),
      isDetectingLocalAgentsByContext: removeLocalAgentContextEntries(
        args.state.isDetectingLocalAgentsByContext,
        removedContextKeys
      ),
      isRefreshingLocalAgentsByContext: removeLocalAgentContextEntries(
        args.state.isRefreshingLocalAgentsByContext,
        removedContextKeys
      )
    }
  }
}

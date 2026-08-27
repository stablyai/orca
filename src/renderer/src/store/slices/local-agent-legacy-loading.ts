import type { AppState } from '../types'
import { removeLocalAgentContextEntry } from './local-agent-context-eviction'

type LocalAgentLegacyLoadingState = Pick<
  AppState,
  'detectedAgentIds' | 'isDetectingAgents' | 'isRefreshingAgents'
>

type LocalAgentLegacyLoadingPatch = Partial<LocalAgentLegacyLoadingState>

export function getLegacyLoadingPatch(
  state: LocalAgentLegacyLoadingState,
  contextMatches: boolean,
  phase: 'detect' | 'refresh'
): LocalAgentLegacyLoadingPatch | null {
  const detectedAgentIds = contextMatches ? state.detectedAgentIds : null
  const alreadyLoading = phase === 'detect' ? state.isDetectingAgents : state.isRefreshingAgents
  if (state.detectedAgentIds === detectedAgentIds && alreadyLoading) {
    return null
  }
  return phase === 'detect'
    ? { detectedAgentIds, isDetectingAgents: true }
    : { detectedAgentIds, isRefreshingAgents: true }
}

export function getSupersededDetectPatch(
  state: LocalAgentLegacyLoadingState & Pick<AppState, 'isDetectingLocalAgentsByContext'>,
  contextKey: string,
  supersedesDetect: boolean,
  clearsLegacyDetect: boolean
): Partial<AppState> {
  return {
    ...(clearsLegacyDetect ? { isDetectingAgents: false } : {}),
    ...(supersedesDetect
      ? {
          isDetectingLocalAgentsByContext: removeLocalAgentContextEntry(
            state.isDetectingLocalAgentsByContext,
            contextKey
          )
        }
      : {})
  }
}

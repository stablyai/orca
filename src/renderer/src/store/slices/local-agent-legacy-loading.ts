import type { AppState } from '../types'

type LocalAgentLegacyLoadingState = Pick<
  AppState,
  'detectedAgentIds' | 'isDetectingAgents' | 'isRefreshingAgents'
>

type LocalAgentLegacyLoadingPatch = Partial<LocalAgentLegacyLoadingState>

export function getLocalAgentLegacyLoadingPatch(
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

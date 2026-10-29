import type { AppState } from '../types'
import type {
  PathSource,
  ShellHydrationFailureReason
} from '../../../../shared/shell-path-hydration-types'
import type { TuiAgent } from '../../../../shared/tui-agent'

export type LocalDetectedAgentState = {
  readLocalAgentInventory: (worktreeId?: string | null) => {
    ids: TuiAgent[] | null
    state: 'pending' | 'successful' | 'failed'
  }
  detectedAgentIds: TuiAgent[] | null
  isDetectingAgents: boolean
  isRefreshingAgents: boolean
  localDetectedAgentIdsByContext: Record<string, TuiAgent[] | null>
  isDetectingLocalAgentsByContext: Record<string, boolean>
  isRefreshingLocalAgentsByContext: Record<string, boolean>
  pathSource: PathSource | null
  pathFailureReason: ShellHydrationFailureReason | null
  ensureAllDetectedAgents: (worktreeId?: string | null) => Promise<TuiAgent[]>
  refreshAllDetectedAgents: (worktreeId?: string | null) => Promise<TuiAgent[]>
  ensureNativeDetectedAgents: () => Promise<TuiAgent[]>
  ensureDetectedAgents: (worktreeId?: string | null) => Promise<TuiAgent[]>
  refreshDetectedAgents: (worktreeId?: string | null) => Promise<TuiAgent[]>
  clearLocalDetectedAgentContextsForProjects: (projectIds: readonly string[]) => void
  clearLocalDetectedAgents: () => void
}

export function createEmptyLocalDetectedAgentState(): Pick<
  AppState,
  | 'detectedAgentIds'
  | 'isDetectingAgents'
  | 'isRefreshingAgents'
  | 'localDetectedAgentIdsByContext'
  | 'isDetectingLocalAgentsByContext'
  | 'isRefreshingLocalAgentsByContext'
  | 'pathSource'
  | 'pathFailureReason'
> {
  return {
    detectedAgentIds: null,
    isDetectingAgents: false,
    isRefreshingAgents: false,
    localDetectedAgentIdsByContext: {},
    isDetectingLocalAgentsByContext: {},
    isRefreshingLocalAgentsByContext: {},
    pathSource: null,
    pathFailureReason: null
  }
}

export function readNativeDetectedAgents(state: {
  localDetectedAgentIdsByContext?: LocalDetectedAgentState['localDetectedAgentIdsByContext']
}): TuiAgent[] | null {
  return state.localDetectedAgentIdsByContext?.host ?? null
}

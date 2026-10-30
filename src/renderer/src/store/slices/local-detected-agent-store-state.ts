import type { AppState } from '../types'
import type {
  PathSource,
  ShellHydrationFailureReason
} from '../../../../shared/shell-path-hydration-types'
import type { TuiAgent } from '../../../../shared/tui-agent'

/** `wakeWslDistro`: a user act (a click, a runtime choice) that may start a stopped WSL distro. */
export type LocalAgentRefreshOptions = { wakeWslDistro?: boolean }

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
  refreshAllDetectedAgents: (
    worktreeId?: string | null,
    options?: LocalAgentRefreshOptions
  ) => Promise<TuiAgent[]>
  ensureNativeDetectedAgents: () => Promise<TuiAgent[]>
  ensureDetectedAgents: (worktreeId?: string | null) => Promise<TuiAgent[]>
  /** The focused (or given) workspace's last agent probe was refused because its WSL distro was not running. */
  isLocalAgentInventoryRefused: (worktreeId?: string | null) => boolean
  /** Opening an agent-launch picker is a user act: a list a stopped WSL distro refused may wake it. */
  ensureDetectedAgentsForPicker: (worktreeId?: string | null) => Promise<TuiAgent[]>
  refreshDetectedAgents: (
    worktreeId?: string | null,
    options?: LocalAgentRefreshOptions
  ) => Promise<TuiAgent[]>
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

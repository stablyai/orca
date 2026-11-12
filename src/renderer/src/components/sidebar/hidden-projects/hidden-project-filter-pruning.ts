import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import {
  indexHiddenProjects,
  withoutHiddenFilterRepoIds
} from '../../../../../shared/hidden-projects'

/** A project filter naming a project with no listed copy left would hide everything; drop the id. */
export function pruneHiddenProjectFilterIds(state: AppState): void {
  if (!state.persistedUIReady) {
    return
  }
  const hidden = indexHiddenProjects(state.repos, LOCAL_EXECUTION_HOST_ID)
  if (!hidden.any) {
    return
  }
  const workspaceIds = withoutHiddenFilterRepoIds(state.filterRepoIds, hidden)
  if (workspaceIds !== state.filterRepoIds) {
    state.setFilterRepoIds([...workspaceIds])
  }
  const agentIds = withoutHiddenFilterRepoIds(state.agentsFilterRepoIds, hidden)
  if (agentIds !== state.agentsFilterRepoIds) {
    state.setAgentsFilterRepoIds([...agentIds])
  }
}

/** Prunes on every repo-list change, so hides from the CLI or another window are covered too. */
export function followHiddenProjectFilters(): () => void {
  pruneHiddenProjectFilterIds(useAppStore.getState())
  return useAppStore.subscribe((state, previous) => {
    if (state.repos !== previous.repos || state.persistedUIReady !== previous.persistedUIReady) {
      pruneHiddenProjectFilterIds(state)
    }
  })
}

import { useEffect, useRef } from 'react'
import type {
  AzureDevOpsBacklogPage,
  AzureDevOpsBacklogViewSettings
} from '../../../shared/azure-devops/boards-types'
import type { Repo } from '../../../shared/repo-types'
import type { BacklogFilters } from './task-page-azure-devops-backlog-filters'
import { EMPTY_BACKLOG_FILTERS } from './task-page-azure-devops-backlog-filters'
import { seedBacklogFiltersFromSaved } from './task-page-azure-devops-backlog-saved-filter-seed'

/**
 * Seeds the local view state from the user's own ADO settings, once per scope,
 * so a later local edit is never overwritten by a refetch: Show parents and
 * In progress items once per (repo, team); the saved filter once per (repo, team, level),
 * after that level's page has loaded (assignees resolve through its items).
 */
export function useAzureDevOpsViewStateSeeding(args: {
  repo: Repo | null
  teamName: string | null
  levelId: string | null
  viewSettings: AzureDevOpsBacklogViewSettings | null | undefined
  /** Undefined until the team configuration has been loaded. */
  configurationLoaded: boolean
  page: AzureDevOpsBacklogPage | null
  setShowParents: (next: boolean) => void
  setShowInProgress: (next: boolean) => void
  setFilters: (next: BacklogFilters) => void
}): void {
  const {
    repo,
    teamName,
    levelId,
    viewSettings,
    configurationLoaded,
    page,
    setShowParents,
    setShowInProgress,
    setFilters
  } = args
  const seededTeamRef = useRef<string | null>(null)
  const seededLevelRef = useRef<string | null>(null)

  const teamKey = repo && teamName ? `${repo.id}::${teamName}` : null
  useEffect(() => {
    if (!teamKey || !configurationLoaded || seededTeamRef.current === teamKey) {
      return
    }
    seededTeamRef.current = teamKey
    setShowParents(viewSettings?.showParents ?? false)
    setShowInProgress(viewSettings?.inProgressFilter ?? true)
  }, [teamKey, configurationLoaded, viewSettings, setShowParents, setShowInProgress])

  const levelKey = teamKey && levelId ? `${teamKey}::${levelId}` : null
  useEffect(() => {
    if (!levelKey || !page || page.level.id !== levelId || seededLevelRef.current === levelKey) {
      return
    }
    seededLevelRef.current = levelKey
    const saved = levelId ? viewSettings?.savedFiltersByLevel[levelId] : undefined
    setFilters(
      saved
        ? seedBacklogFiltersFromSaved(saved, [...page.items, ...page.children])
        : EMPTY_BACKLOG_FILTERS
    )
  }, [levelKey, levelId, page, viewSettings, setFilters])
}

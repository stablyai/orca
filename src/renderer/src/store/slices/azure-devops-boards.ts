import type { StateCreator } from 'zustand'
import type {
  AzureDevOpsBacklogLevel,
  AzureDevOpsBacklogPage,
  AzureDevOpsBoardPage,
  AzureDevOpsTeam,
  AzureDevOpsTeamConfiguration,
  AzureDevOpsWorkItemDetail
} from '../../../../shared/azure-devops/boards-types'
import type {
  AzureDevOpsBoardsRepoArgs,
  AzureDevOpsTeamRoute
} from '../../../../shared/azure-devops/boards-repo-resolution'
import type { Repo } from '../../../../shared/repo-types'
import { WORK_ITEMS_CACHE_TTL } from '../github/cache-policy'
import type { AppState } from '../types'

export type AzureDevOpsBacklogCacheEntry = { page: AzureDevOpsBacklogPage; loadedAt: number }

export type AzureDevOpsBoardCacheEntry = { page: AzureDevOpsBoardPage; loadedAt: number }

export type AzureDevOpsBoardsSlice = {
  azureDevOpsTeamsByRepo: Record<string, AzureDevOpsTeam[]>
  azureDevOpsConfigurationByTeam: Record<string, AzureDevOpsTeamConfiguration>
  azureDevOpsBacklogByKey: Record<string, AzureDevOpsBacklogCacheEntry>
  azureDevOpsBoardByKey: Record<string, AzureDevOpsBoardCacheEntry>
  loadAzureDevOpsTeams: (repo: Repo) => Promise<AzureDevOpsTeam[]>
  loadAzureDevOpsConfiguration: (
    repo: Repo,
    team: AzureDevOpsTeamRoute,
    options?: { force?: boolean }
  ) => Promise<AzureDevOpsTeamConfiguration>
  /** Cached page for the key, fresh or stale, without a request. */
  readAzureDevOpsBacklog: (
    repo: Repo,
    team: AzureDevOpsTeamRoute,
    level: AzureDevOpsBacklogLevel
  ) => { page: AzureDevOpsBacklogPage; fresh: boolean } | null
  loadAzureDevOpsBacklog: (
    repo: Repo,
    team: AzureDevOpsTeamRoute,
    level: AzureDevOpsBacklogLevel,
    options?: { force?: boolean; columnFields?: string[] }
  ) => Promise<AzureDevOpsBacklogPage>
  /** Cached board for the key, fresh or stale, without a request. */
  readAzureDevOpsBoard: (
    repo: Repo,
    team: AzureDevOpsTeamRoute,
    level: AzureDevOpsBacklogLevel
  ) => AzureDevOpsBoardPage | null
  /** Resolves null when the level has no board; null is not cached. */
  loadAzureDevOpsBoard: (
    repo: Repo,
    team: AzureDevOpsTeamRoute,
    level: AzureDevOpsBacklogLevel,
    options?: { force?: boolean }
  ) => Promise<AzureDevOpsBoardPage | null>
  /** @param cachedIds Ids the caller holds, so the host only hydrates the children it must. */
  loadAzureDevOpsWorkItem: (
    repo: Repo,
    id: number,
    cachedIds?: number[]
  ) => Promise<AzureDevOpsWorkItemDetail | null>
  isAzureDevOpsAuthenticated: (repo: Repo) => Promise<boolean>
}

// Why: same revalidation window as GitHub / Linear / Jira work-item lists.
export const AZURE_DEVOPS_BACKLOG_CACHE_TTL = WORK_ITEMS_CACHE_TTL

export function azureDevOpsTeamKey(repo: Pick<Repo, 'id'>, team: AzureDevOpsTeamRoute): string {
  return `${repo.id}::${team.teamId ?? team.teamName}`
}

export function azureDevOpsBacklogKey(
  repo: Pick<Repo, 'id'>,
  team: AzureDevOpsTeamRoute,
  levelId: string
): string {
  return `${azureDevOpsTeamKey(repo, team)}::${levelId}`
}

export function azureDevOpsBoardKey(
  repo: Pick<Repo, 'id'>,
  team: AzureDevOpsTeamRoute,
  levelId: string
): string {
  return `${azureDevOpsBacklogKey(repo, team, levelId)}::board`
}

export function isAzureDevOpsBacklogEntryFresh(
  entry: AzureDevOpsBacklogCacheEntry | AzureDevOpsBoardCacheEntry,
  now = Date.now()
): boolean {
  return now - entry.loadedAt < AZURE_DEVOPS_BACKLOG_CACHE_TTL
}

function repoArgs(repo: Repo): AzureDevOpsBoardsRepoArgs {
  return { repoPath: repo.path, repoId: repo.id, connectionId: repo.connectionId ?? null }
}

function teamArgs(team: AzureDevOpsTeamRoute): AzureDevOpsTeamRoute {
  return { teamName: team.teamName, teamId: team.teamId ?? null }
}

export const createAzureDevOpsBoardsSlice: StateCreator<
  AppState,
  [],
  [],
  AzureDevOpsBoardsSlice
> = (set, get) => ({
  azureDevOpsTeamsByRepo: {},
  azureDevOpsConfigurationByTeam: {},
  azureDevOpsBacklogByKey: {},
  azureDevOpsBoardByKey: {},

  isAzureDevOpsAuthenticated: (repo) =>
    window.api.azureDevOpsBoards.isAuthenticated(repoArgs(repo)),

  loadAzureDevOpsTeams: async (repo) => {
    const teams = await window.api.azureDevOpsBoards.listTeams(repoArgs(repo))
    set((state) => ({
      azureDevOpsTeamsByRepo: { ...state.azureDevOpsTeamsByRepo, [repo.id]: teams }
    }))
    return teams
  },

  loadAzureDevOpsConfiguration: async (repo, team, options) => {
    const key = azureDevOpsTeamKey(repo, team)
    const cached = get().azureDevOpsConfigurationByTeam[key]
    if (cached && !options?.force) {
      return cached
    }
    const configuration = await window.api.azureDevOpsBoards.getConfiguration({
      ...repoArgs(repo),
      ...teamArgs(team)
    })
    set((state) => ({
      azureDevOpsConfigurationByTeam: {
        ...state.azureDevOpsConfigurationByTeam,
        [key]: configuration
      }
    }))
    return configuration
  },

  readAzureDevOpsBacklog: (repo, team, level) => {
    const entry = get().azureDevOpsBacklogByKey[azureDevOpsBacklogKey(repo, team, level.id)]
    return entry ? { page: entry.page, fresh: isAzureDevOpsBacklogEntryFresh(entry) } : null
  },

  loadAzureDevOpsBacklog: async (repo, team, level, options) => {
    const key = azureDevOpsBacklogKey(repo, team, level.id)
    const cached = get().azureDevOpsBacklogByKey[key]
    if (cached && !options?.force && isAzureDevOpsBacklogEntryFresh(cached)) {
      return cached.page
    }
    const page = await window.api.azureDevOpsBoards.loadBacklog({
      ...repoArgs(repo),
      ...teamArgs(team),
      level,
      ...(options?.columnFields ? { columnFields: options.columnFields } : {})
    })
    set((state) => ({
      azureDevOpsBacklogByKey: {
        ...state.azureDevOpsBacklogByKey,
        [key]: { page, loadedAt: Date.now() }
      }
    }))
    return page
  },

  readAzureDevOpsBoard: (repo, team, level) =>
    get().azureDevOpsBoardByKey[azureDevOpsBoardKey(repo, team, level.id)]?.page ?? null,

  loadAzureDevOpsBoard: async (repo, team, level, options) => {
    const key = azureDevOpsBoardKey(repo, team, level.id)
    const cached = get().azureDevOpsBoardByKey[key]
    if (cached && !options?.force && isAzureDevOpsBacklogEntryFresh(cached)) {
      return cached.page
    }
    const page = await window.api.azureDevOpsBoards.loadBoard({
      ...repoArgs(repo),
      ...teamArgs(team),
      level
    })
    if (page) {
      set((state) => ({
        azureDevOpsBoardByKey: {
          ...state.azureDevOpsBoardByKey,
          [key]: { page, loadedAt: Date.now() }
        }
      }))
    }
    return page
  },

  loadAzureDevOpsWorkItem: (repo, id, cachedIds) =>
    window.api.azureDevOpsBoards.getWorkItem({
      ...repoArgs(repo),
      id,
      ...(cachedIds ? { cachedIds } : {})
    })
})

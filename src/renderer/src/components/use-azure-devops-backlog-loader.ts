import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  persistAzureDevOpsTeamSelection,
  type AzureDevOpsTeamSelectionSettings
} from './task-page-azure-devops-team-selection-persistence'
import type {
  AzureDevOpsBacklogColumnField,
  AzureDevOpsBacklogLevel,
  AzureDevOpsBacklogPage,
  AzureDevOpsTeam,
  AzureDevOpsTeamConfiguration
} from '../../../shared/azure-devops/boards-types'
import type { AzureDevOpsTeamRoute } from '../../../shared/azure-devops/boards-repo-resolution'
import type { Repo } from '../../../shared/repo-types'
import { resolveAzureDevOpsBacklogColumns } from './task-page-azure-devops-backlog-columns'
import {
  azureDevOpsTeamSelectionKey,
  listVisibleAzureDevOpsLevels,
  pickDefaultAzureDevOpsLevel,
  resolveAzureDevOpsLoadFailure,
  type AzureDevOpsViewsStatus
} from './task-page-azure-devops-backlog-level-selection'

const EMPTY_TEAMS: AzureDevOpsTeam[] = []

export type { AzureDevOpsTeamSelectionSettings }

// Why: split out of the top-level hook so team/config/backlog loading, and its
// effects, don't push the orchestrating hook file over the line budget.
export function useAzureDevOpsBacklogLoader(args: {
  active: boolean
  repo: Repo | null
  settings: AzureDevOpsTeamSelectionSettings | null | undefined
  updateSettings: (patch: AzureDevOpsTeamSelectionSettings) => Promise<unknown>
}): {
  status: AzureDevOpsViewsStatus
  errorMessage: string | null
  teams: AzureDevOpsTeam[]
  team: AzureDevOpsTeam | null
  teamName: string | null
  selectTeam: (teamName: string) => void
  configuration: AzureDevOpsTeamConfiguration | null
  level: AzureDevOpsBacklogLevel | null
  /** Effective columns for `level` (user options → process → built-in); hydrated on load. */
  columns: AzureDevOpsBacklogColumnField[]
  levelId: string | null
  setLevelId: (id: string | null) => void
  page: AzureDevOpsBacklogPage | null
  setPage: (page: AzureDevOpsBacklogPage | null) => void
  refresh: () => void
  refreshing: boolean
} {
  const { active, repo, settings, updateSettings } = args
  const {
    azureDevOpsTeamsByRepo,
    loadAzureDevOpsTeams,
    loadAzureDevOpsConfiguration,
    readAzureDevOpsBacklog,
    loadAzureDevOpsBacklog,
    isAzureDevOpsAuthenticated
  } = useAppStore(
    useShallow((s) => ({
      azureDevOpsTeamsByRepo: s.azureDevOpsTeamsByRepo,
      loadAzureDevOpsTeams: s.loadAzureDevOpsTeams,
      loadAzureDevOpsConfiguration: s.loadAzureDevOpsConfiguration,
      readAzureDevOpsBacklog: s.readAzureDevOpsBacklog,
      loadAzureDevOpsBacklog: s.loadAzureDevOpsBacklog,
      isAzureDevOpsAuthenticated: s.isAzureDevOpsAuthenticated
    }))
  )

  const [status, setStatus] = useState<AzureDevOpsViewsStatus>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [teamName, setTeamName] = useState<string | null>(null)
  const [configuration, setConfiguration] = useState<AzureDevOpsTeamConfiguration | null>(null)
  const [levelId, setLevelId] = useState<string | null>(null)
  const [page, setPage] = useState<AzureDevOpsBacklogPage | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  // Why: the persisted team is applied once per repo; a later user pick must never be reverted.
  const persistedAppliedForRepoRef = useRef<string | null>(null)
  // Why: consumed by the load it triggered, so later level switches go back to the cache.
  const forceNextLoadRef = useRef(false)
  const settingsRef = useRef(settings)
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  const teams = useMemo(
    () => (repo ? (azureDevOpsTeamsByRepo[repo.id] ?? EMPTY_TEAMS) : EMPTY_TEAMS),
    [repo, azureDevOpsTeamsByRepo]
  )
  const team = useMemo(() => teams.find((t) => t.name === teamName) ?? null, [teams, teamName])
  const teamRoute = useMemo<AzureDevOpsTeamRoute | null>(
    () => (teamName ? { teamName, teamId: team?.id ?? null } : null),
    [teamName, team]
  )

  const applyFailure = useCallback((error: unknown) => {
    const failure = resolveAzureDevOpsLoadFailure(error)
    setStatus(failure.status)
    setErrorMessage(failure.message)
  }, [])

  // Repo → auth → teams. Every piece of per-repo state resets when the repo changes.
  useEffect(() => {
    setTeamName(null)
    setConfiguration(null)
    setLevelId(null)
    setPage(null)
    setErrorMessage(null)
    setRefreshing(false)
    if (!active || !repo) {
      setStatus('idle')
      return
    }
    let cancelled = false
    setStatus('loading')
    void (async () => {
      const authenticated = await isAzureDevOpsAuthenticated(repo)
      if (cancelled) {
        return
      }
      if (!authenticated) {
        setStatus('unauthenticated')
        return
      }
      const list = await loadAzureDevOpsTeams(repo)
      if (cancelled) {
        return
      }
      if (list.length === 0) {
        setStatus('error')
        setErrorMessage(
          translate(
            'auto.components.TaskPage.azureDevOps.noTeams',
            'No teams were found in this Azure DevOps project.'
          )
        )
        return
      }
      setTeamName(list.find((t) => t.isDefault)?.name ?? list[0].name)
    })().catch((error: unknown) => {
      if (!cancelled) {
        applyFailure(error)
      }
    })
    return () => {
      cancelled = true
    }
  }, [active, repo, isAzureDevOpsAuthenticated, loadAzureDevOpsTeams, applyFailure])

  // Configuration for the selected team; the persisted team is applied once org/project are known.
  useEffect(() => {
    if (!active || !repo || !teamRoute) {
      return
    }
    let cancelled = false
    void loadAzureDevOpsConfiguration(repo, teamRoute)
      .then((config) => {
        if (cancelled) {
          return
        }
        if (persistedAppliedForRepoRef.current !== repo.id) {
          persistedAppliedForRepoRef.current = repo.id
          const persisted =
            settingsRef.current?.azureDevOpsTeamSelection?.[
              azureDevOpsTeamSelectionKey(config.repo)
            ]
          if (
            persisted &&
            persisted !== teamRoute.teamName &&
            teams.some((t) => t.name === persisted)
          ) {
            setTeamName(persisted)
            return
          }
        }
        setConfiguration(config)
        const visible = listVisibleAzureDevOpsLevels(config.backlog?.levels ?? [])
        setLevelId((current) =>
          current && visible.some((l) => l.id === current)
            ? current
            : (pickDefaultAzureDevOpsLevel(visible)?.id ?? null)
        )
        if (visible.length === 0) {
          setStatus('error')
          setErrorMessage(
            translate(
              'auto.components.TaskPage.azureDevOps.noLevels',
              'This team has no visible backlog levels.'
            )
          )
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          applyFailure(error)
        }
      })
    return () => {
      cancelled = true
    }
  }, [active, repo, teamRoute, teams, loadAzureDevOpsConfiguration, applyFailure])

  const level = useMemo(
    () => configuration?.backlog?.levels.find((l) => l.id === levelId) ?? null,
    [configuration, levelId]
  )
  const columns = useMemo(
    () => resolveAzureDevOpsBacklogColumns(level, configuration?.viewSettings),
    [level, configuration]
  )

  // Backlog page for the selected level: stale-while-revalidate over the slice cache.
  useEffect(() => {
    if (!active || !repo || !teamRoute || !level) {
      return
    }
    let cancelled = false
    const force = forceNextLoadRef.current
    const cached = readAzureDevOpsBacklog(repo, teamRoute, level)
    if (cached) {
      setPage(cached.page)
      setStatus('ready')
      if (cached.fresh && !force) {
        return
      }
    } else {
      setStatus('loading')
    }
    setRefreshing(true)
    void loadAzureDevOpsBacklog(repo, teamRoute, level, {
      force: true,
      columnFields: columns.map((c) => c.referenceName)
    })
      .then((loaded) => {
        if (cancelled) {
          return
        }
        setPage(loaded)
        setStatus('ready')
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          applyFailure(error)
        }
      })
      .finally(() => {
        if (!cancelled) {
          forceNextLoadRef.current = false
          setRefreshing(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    active,
    repo,
    teamRoute,
    level,
    columns,
    refreshNonce,
    readAzureDevOpsBacklog,
    loadAzureDevOpsBacklog,
    applyFailure
  ])

  const refresh = useCallback(() => {
    forceNextLoadRef.current = true
    setRefreshNonce((n) => n + 1)
  }, [])

  const selectTeam = useCallback(
    (nextTeam: string) => {
      if (repo) {
        persistedAppliedForRepoRef.current = repo.id
      }
      setTeamName(nextTeam)
      setPage(null)
      setStatus('loading')
      if (configuration) {
        persistAzureDevOpsTeamSelection({
          repo: configuration.repo,
          teamName: nextTeam,
          settings: settingsRef.current,
          updateSettings
        })
      }
    },
    [repo, configuration, updateSettings]
  )

  return {
    status,
    errorMessage,
    teams,
    team,
    teamName,
    selectTeam,
    configuration,
    level,
    columns,
    levelId,
    setLevelId,
    page,
    setPage,
    refresh,
    refreshing
  }
}

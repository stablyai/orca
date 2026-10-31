import { getRepoHostIdentity } from '../../../../../../shared/repo-host-identity'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { getProjectSectionRepoLookup } from '../../../../../../shared/project-section-reveal'
import { partitionDetectedWorktreesByHost } from '../../worktree-visibility-host-target'
import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  getImportedWorktreesKeepHiddenError,
  keepImportedWorktreesHiddenCard,
  showImportedWorktreesCard,
  type ImportedWorktreeCardActionState
} from '../../imported-worktrees-card-actions'
import {
  buildImportedWorktreesCardCandidates,
  getHiddenImportedWorktrees
} from '../../imported-worktrees-card-candidates'
import {
  suppressNewExternalWorktreeInbox,
  type NewExternalWorktreesInboxActionState
} from '../../new-external-worktrees-inbox-actions'
import { buildNewExternalWorktreesInboxCandidates } from '../../new-external-worktrees-inbox-candidates'
import { selectDetectedWorktreesByRepo } from '@/store/workspace-record-selectors'

export function useSidebarExternalWorktreeCards(args: {
  repos: readonly Repo[]
  visibleReposForRows: readonly Repo[]
  detectedWorktreesByRepo: AppState['detectedWorktreesByRepo']
  filterRepoIds: readonly string[]
}) {
  const { repos, visibleReposForRows, detectedWorktreesByRepo, filterRepoIds } = args
  const updateRepo = useAppStore((s) => s.updateRepo)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const settings = useAppStore((s) => s.settings)
  const visibilityDefaultsByHost = useAppStore((s) => s.worktreeVisibilityDefaultsByHost)
  const [importedWorktreeCardActionState, setImportedWorktreeCardActionState] = useState<
    Map<string, ImportedWorktreeCardActionState>
  >(new Map())
  const [newExternalWorktreeInboxActionState, setNewExternalWorktreeInboxActionState] = useState<
    Map<string, NewExternalWorktreesInboxActionState>
  >(new Map())
  const [suppressExternalWorktreeInboxRepoId, setSuppressExternalWorktreeInboxRepoId] =
    useState<Repo | null>(null)

  const detectedByHost = useMemo(
    () => partitionDetectedWorktreesByHost(repos, detectedWorktreesByRepo),
    [repos, detectedWorktreesByRepo]
  )
  const targetActions = useCallback(
    (repo: Repo) => ({
      projectId: repo.id,
      updateRepo: (id: string, updates: Parameters<AppState['updateRepo']>[1]) =>
        updateRepo(id, updates, { hostId: getRepoExecutionHostId(repo) }),
      fetchWorktrees: (id: string, options?: { requireAuthoritative?: boolean }) =>
        fetchWorktrees(id, { ...options, executionHostId: getRepoExecutionHostId(repo) })
    }),
    [updateRepo, fetchWorktrees]
  )
  const importedWorktreesByRepo = useMemo(() => {
    const forceVisibleRepoIds = new Set(
      [...importedWorktreeCardActionState.entries()]
        .filter(([, state]) => state.forceVisible)
        .map(([repoId]) => repoId)
    )
    return buildImportedWorktreesCardCandidates({
      repos: visibleReposForRows,
      allRepos: repos,
      detectedWorktreesByHost: detectedByHost,
      detectedWorktreesByRepo,
      filterRepoIds,
      forceVisibleRepoIds,
      settings,
      visibilityDefaultsByHost
    })
  }, [
    detectedWorktreesByRepo,
    detectedByHost,
    repos,
    filterRepoIds,
    importedWorktreeCardActionState,
    settings,
    visibilityDefaultsByHost,
    visibleReposForRows
  ])
  const newExternalWorktreesInboxByRepo = useMemo(
    () =>
      buildNewExternalWorktreesInboxCandidates({
        repos: visibleReposForRows,
        allRepos: repos,
        detectedWorktreesByHost: detectedByHost,
        detectedWorktreesByRepo,
        filterRepoIds,
        settings,
        visibilityDefaultsByHost
      }),
    [
      detectedWorktreesByRepo,
      detectedByHost,
      repos,
      filterRepoIds,
      settings,
      visibilityDefaultsByHost,
      visibleReposForRows
    ]
  )

  const setImportedWorktreeCardState = useCallback(
    (projectId: string, state: ImportedWorktreeCardActionState | null) => {
      setImportedWorktreeCardActionState((previous) => {
        const next = new Map(previous)
        if (state) {
          next.set(projectId, state)
        } else {
          next.delete(projectId)
        }
        return next
      })
    },
    []
  )

  const handleShowImportedWorktrees = useCallback(
    async (repo: Repo) => {
      const identity = getRepoHostIdentity(repo)
      await showImportedWorktreesCard({
        ...targetActions(repo),
        forceVisible: importedWorktreeCardActionState.get(identity)?.forceVisible === true,
        setCardState: (_, state) => setImportedWorktreeCardState(identity, state)
      })
    },
    [targetActions, importedWorktreeCardActionState, setImportedWorktreeCardState]
  )

  const handleKeepImportedWorktreesHidden = useCallback(
    async (target: Repo) => {
      const identity = getRepoHostIdentity(target)
      const readCurrent = () => {
        const state = useAppStore.getState()
        return {
          repo: getProjectSectionRepoLookup(state.repos).get(identity),
          detected: partitionDetectedWorktreesByHost(
            state.repos,
            selectDetectedWorktreesByRepo(state)
          ).get(identity)
        }
      }
      let current = readCurrent()
      if (current.repo && current.detected?.authoritative !== true) {
        const refreshed = await targetActions(target).fetchWorktrees(target.id, {
          requireAuthoritative: true
        })
        if (!refreshed) {
          setImportedWorktreeCardState(identity, {
            pending: false,
            error: getImportedWorktreesKeepHiddenError()
          })
          return
        }
        current = readCurrent()
      }
      if (!current.repo || current.detected?.authoritative !== true) {
        setImportedWorktreeCardState(identity, {
          pending: false,
          error: getImportedWorktreesKeepHiddenError()
        })
        return
      }
      await keepImportedWorktreesHiddenCard({
        ...targetActions(current.repo),
        setCardState: (_, state) => setImportedWorktreeCardState(identity, state),
        hiddenWorktreePaths: getHiddenImportedWorktrees(current.detected).map(
          (worktree) => worktree.path
        ),
        existingBaselinePaths: current.repo.externalWorktreeInboxBaselinePaths
      })
    },
    [targetActions, setImportedWorktreeCardState]
  )

  const setNewExternalWorktreeInboxState = useCallback(
    (projectId: string, state: NewExternalWorktreesInboxActionState | null) => {
      setNewExternalWorktreeInboxActionState((previous) => {
        const next = new Map(previous)
        if (state) {
          next.set(projectId, state)
        } else {
          next.delete(projectId)
        }
        return next
      })
    },
    []
  )

  const handleOpenSuppressExternalWorktreeInbox = useCallback((repo: Repo) => {
    setSuppressExternalWorktreeInboxRepoId(repo)
  }, [])

  const handleConfirmSuppressExternalWorktreeInbox = useCallback(async () => {
    if (!suppressExternalWorktreeInboxRepoId) {
      return
    }
    const identity = getRepoHostIdentity(suppressExternalWorktreeInboxRepoId)
    const repo = getProjectSectionRepoLookup(useAppStore.getState().repos).get(identity)
    if (!repo) {
      setSuppressExternalWorktreeInboxRepoId(null)
      return
    }
    const inboxWorktrees = newExternalWorktreesInboxByRepo.get(identity)?.inboxWorktrees ?? []
    const suppressed = await suppressNewExternalWorktreeInbox({
      ...targetActions(repo),
      repo,
      worktreePaths: inboxWorktrees.map((worktree) => worktree.path),
      setInboxState: (_, state) => setNewExternalWorktreeInboxState(identity, state)
    })
    if (suppressed) {
      setSuppressExternalWorktreeInboxRepoId(null)
    }
  }, [
    newExternalWorktreesInboxByRepo,
    setNewExternalWorktreeInboxState,
    suppressExternalWorktreeInboxRepoId,
    targetActions
  ])

  return {
    importedWorktreeCardActionState,
    newExternalWorktreeInboxActionState,
    importedWorktreesByRepo,
    newExternalWorktreesInboxByRepo,
    suppressExternalWorktreeInboxRepoId,
    setSuppressExternalWorktreeInboxRepoId,
    handleShowImportedWorktrees,
    handleKeepImportedWorktreesHidden,
    handleOpenSuppressExternalWorktreeInbox,
    handleConfirmSuppressExternalWorktreeInbox
  }
}

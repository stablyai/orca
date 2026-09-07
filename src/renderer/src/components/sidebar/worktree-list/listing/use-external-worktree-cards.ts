import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  IMPORTED_WORKTREES_KEEP_HIDDEN_ERROR,
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

// The two sidebar notice rows for worktrees Orca detected but does not yet show, plus the
// pending/error state their inline actions surface.
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
  const [suppressExternalWorktreeInboxRepoId, setSuppressExternalWorktreeInboxRepoId] = useState<
    string | null
  >(null)

  const importedWorktreesByRepo = useMemo(() => {
    const forceVisibleRepoIds = new Set(
      [...importedWorktreeCardActionState.entries()]
        .filter(([, state]) => state.forceVisible)
        .map(([repoId]) => repoId)
    )
    return buildImportedWorktreesCardCandidates({
      repos: visibleReposForRows,
      detectedWorktreesByRepo,
      filterRepoIds,
      forceVisibleRepoIds,
      settings,
      visibilityDefaultsByHost
    })
  }, [
    detectedWorktreesByRepo,
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
        detectedWorktreesByRepo,
        filterRepoIds,
        settings,
        visibilityDefaultsByHost
      }),
    [
      detectedWorktreesByRepo,
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
    async (projectId: string) => {
      await showImportedWorktreesCard({
        projectId,
        forceVisible: importedWorktreeCardActionState.get(projectId)?.forceVisible === true,
        updateRepo,
        fetchWorktrees,
        setCardState: setImportedWorktreeCardState
      })
    },
    [fetchWorktrees, importedWorktreeCardActionState, setImportedWorktreeCardState, updateRepo]
  )

  const handleKeepImportedWorktreesHidden = useCallback(
    async (projectId: string) => {
      const repo = repos.find((candidate) => candidate.id === projectId)
      let detected = detectedWorktreesByRepo[projectId]
      // Why: baseline seeding needs authoritative hidden paths, so don't dismiss on a stale snapshot.
      if (detected?.authoritative !== true) {
        const refreshed = await fetchWorktrees(projectId, { requireAuthoritative: true })
        if (!refreshed) {
          setImportedWorktreeCardState(projectId, {
            pending: false,
            error: IMPORTED_WORKTREES_KEEP_HIDDEN_ERROR
          })
          return
        }
        detected = useAppStore.getState().detectedWorktreesByRepo[projectId]
      }
      if (detected?.authoritative !== true) {
        setImportedWorktreeCardState(projectId, {
          pending: false,
          error: IMPORTED_WORKTREES_KEEP_HIDDEN_ERROR
        })
        return
      }
      await keepImportedWorktreesHiddenCard({
        projectId,
        updateRepo,
        setCardState: setImportedWorktreeCardState,
        hiddenWorktreePaths: getHiddenImportedWorktrees(detected).map((worktree) => worktree.path),
        existingBaselinePaths: repo?.externalWorktreeInboxBaselinePaths
      })
    },
    [detectedWorktreesByRepo, fetchWorktrees, repos, setImportedWorktreeCardState, updateRepo]
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

  const handleOpenSuppressExternalWorktreeInbox = useCallback((projectId: string) => {
    setSuppressExternalWorktreeInboxRepoId(projectId)
  }, [])

  const handleConfirmSuppressExternalWorktreeInbox = useCallback(async () => {
    if (!suppressExternalWorktreeInboxRepoId) {
      return
    }
    const projectId = suppressExternalWorktreeInboxRepoId
    const repo = repos.find((candidate) => candidate.id === projectId)
    if (!repo) {
      setSuppressExternalWorktreeInboxRepoId(null)
      return
    }
    const inboxWorktrees = newExternalWorktreesInboxByRepo.get(projectId)?.inboxWorktrees ?? []
    const suppressed = await suppressNewExternalWorktreeInbox({
      projectId,
      repo,
      worktreePaths: inboxWorktrees.map((worktree) => worktree.path),
      updateRepo,
      setInboxState: setNewExternalWorktreeInboxState
    })
    if (suppressed) {
      setSuppressExternalWorktreeInboxRepoId(null)
    }
  }, [
    newExternalWorktreesInboxByRepo,
    repos,
    setNewExternalWorktreeInboxState,
    suppressExternalWorktreeInboxRepoId,
    updateRepo
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

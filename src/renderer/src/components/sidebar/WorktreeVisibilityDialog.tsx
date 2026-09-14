import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { translate } from '@/i18n/i18n'
import {
  importNewExternalWorktreeInboxPaths,
  type NewExternalWorktreesInboxActionState
} from './new-external-worktrees-inbox-actions'
import WorktreeVisibilityHelpPopover from './WorktreeVisibilityHelpPopover'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import {
  resolveWorktreeVisibilityHostTarget,
  useWorktreeVisibilityHostActions
} from './worktree-visibility-host-target'
import {
  finishVisibilityMutation,
  getActiveVisibilityMutation,
  startVisibilityMutation,
  type ActiveVisibilityMutation,
  useVisibilityMutationFence
} from './worktree-visibility-mutation-fence'
import WorktreeVisibilitySourceList, {
  type WorktreeVisibilitySourceAddResult,
  type WorktreeVisibilitySourceRow
} from './WorktreeVisibilitySourceList'
import type { CustomWorktreeVisibilitySource, Repo } from '../../../../shared/repo-types'
import {
  MAX_CUSTOM_WORKTREE_VISIBILITY_SOURCES,
  effectiveCustomWorktreeSourceVisibility,
  normalizeCustomWorktreeVisibilitySources,
  normalizeWorktreeVisibilitySourcePreferences
} from '../../../../shared/worktree/visibility-sources'
import {
  buildWorktreeSourcePreferenceUpdate,
  removeCustomWorktreeSourcePreference
} from '../../../../shared/worktree/visibility-source-preferences'
import HiddenWorktreeRecoveryList from './HiddenWorktreeRecoveryList'
import { worktreeVisibilityUpdateError } from './worktree-visibility-update-error'
import { useRepoOwnerVisibilityDefaults } from './use-repo-owner-visibility-defaults'
import {
  getLatestRepoForVisibilityScope,
  getRepoCustomWorktreeVisibilitySourceIds,
  isDuplicateWorktreeVisibilitySource
} from './worktree-visibility-repo-sources'
import { WorktreeVisibilityGlobalSettingsLink } from './WorktreeVisibilityGlobalSettingsLink'
import { WorktreeVisibilityScanStatus } from './WorktreeVisibilityScanStatus'
import {
  createWorktreeVisibilityUseGlobalMutation,
  shouldUseGlobalWorktreeVisibility
} from './worktree-visibility-use-global'
import { createWorktreeVisibilitySourceMutation } from './worktree-visibility-source-mutation'

export default function WorktreeVisibilityDialog(): React.JSX.Element | null {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const repos = useAppStore((s) => s.repos)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const detectedWorktreesByRepo = useAppStore((s) => s.detectedWorktreesByRepo)
  const settings = useAppStore((s) => s.settings)
  const [actionState, setActionState] = useState<NewExternalWorktreesInboxActionState | null>(null)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [isToggling, setIsToggling] = useState(false)
  const [listState, setListState] = useState<'checking' | 'ready' | 'failed'>('checking')

  const isOpen = activeModal === 'worktree-visibility'
  const repoId = typeof modalData.repoId === 'string' ? modalData.repoId : ''
  const {
    detected,
    repo,
    requestedHostId,
    scope: mutationScope
  } = resolveWorktreeVisibilityHostTarget(
    { repos, settings, detectedWorktreesByRepo },
    repoId,
    modalData.hostId
  )
  const currentMutationScopeRef = useRef(mutationScope)
  const activeMutation = getActiveVisibilityMutation(mutationScope)
  const effectiveBusyPath =
    busyPath ?? (activeMutation?.kind === 'row' ? activeMutation.path : null)
  const effectivelyToggling = isToggling || activeMutation?.kind === 'toggle'
  const visibilityDefaults = useRepoOwnerVisibilityDefaults(repo)
  const removableSourceIds = useMemo(() => getRepoCustomWorktreeVisibilitySourceIds(repo), [repo])

  useLayoutEffect(() => {
    currentMutationScopeRef.current = mutationScope
  }, [mutationScope])

  const { refreshTargetRepo, updateTargetRepo } = useWorktreeVisibilityHostActions(
    fetchWorktrees,
    updateRepo,
    requestedHostId
  )

  useVisibilityMutationFence({
    scope: mutationScope,
    repoId,
    currentScopeRef: currentMutationScopeRef,
    refresh: refreshTargetRepo,
    setActionState,
    setBusyPath,
    setIsToggling,
    setListState
  })

  // Why: recovery must not trust a stale or fallback snapshot — an empty one
  // would read as "nothing hidden" for a worktree that is sitting on disk (#10324).
  useEffect(() => {
    if (!isOpen || !repoId) {
      return
    }
    // Why: reopening mid-write must not start a scan that can absorb the mutation's confirmation refresh.
    if (getActiveVisibilityMutation(mutationScope)) {
      return
    }
    let cancelled = false
    setListState('checking')
    void refreshTargetRepo(repoId, { requireAuthoritative: true }).then((refreshed) => {
      if (!cancelled) {
        setListState(refreshed ? 'ready' : 'failed')
      }
    })
    return () => {
      cancelled = true
    }
  }, [isOpen, mutationScope, refreshTargetRepo, repoId])

  const handleRetryList = useCallback(async () => {
    if (!repoId) {
      return
    }
    setListState('checking')
    const refreshed = await refreshTargetRepo(repoId, { requireAuthoritative: true })
    if (currentMutationScopeRef.current === mutationScope) {
      setListState(refreshed ? 'ready' : 'failed')
    }
  }, [mutationScope, refreshTargetRepo, repoId])

  const handleShowWorktree = useCallback(
    async (worktreePath: string) => {
      if (!repo) {
        return
      }
      const mutation: ActiveVisibilityMutation = { kind: 'row', path: worktreePath }
      const targetMutationScope = getRepoHostIdentity(repo)
      startVisibilityMutation(targetMutationScope, mutation)
      setBusyPath(worktreePath)
      try {
        await importNewExternalWorktreeInboxPaths({
          projectId: repo.id,
          repo,
          worktreePaths: [worktreePath],
          updateRepo: updateTargetRepo,
          fetchWorktrees: refreshTargetRepo,
          setInboxState: (_projectId, state) => {
            if (currentMutationScopeRef.current !== targetMutationScope) {
              return
            }
            setActionState(state)
            // Why: a null state is only reachable after a successful authoritative
            // refetch, which supersedes an earlier failed open-time scan.
            if (state === null) {
              setListState('ready')
            }
          }
        })
      } finally {
        finishVisibilityMutation(targetMutationScope, mutation)
        if (currentMutationScopeRef.current === targetMutationScope) {
          setBusyPath(null)
        }
      }
    },
    [refreshTargetRepo, repo, updateTargetRepo]
  )

  const commitSourceUpdate = useCallback(
    async (
      updates: Parameters<typeof updateTargetRepo>[1],
      isAccepted: (latestRepo: Repo) => boolean
    ): Promise<boolean> => {
      if (!repoId) {
        return false
      }
      const mutation: ActiveVisibilityMutation = { kind: 'toggle' }
      startVisibilityMutation(mutationScope, mutation)
      setActionState(null)
      setIsToggling(true)
      try {
        const updated = await updateTargetRepo(repoId, updates)
        const latestRepo = getLatestRepoForVisibilityScope(mutationScope)
        if (!updated || !latestRepo || !isAccepted(latestRepo)) {
          if (currentMutationScopeRef.current === mutationScope) {
            setActionState({
              pending: false,
              error: worktreeVisibilityUpdateError(
                updated,
                latestRepo?.worktreeVisibilitySourcePreferences,
                updates.worktreeVisibilitySourcePreferences
              )
            })
          }
          return false
        }
        const refreshed = await refreshTargetRepo(repoId, { requireAuthoritative: true })
        if (currentMutationScopeRef.current === mutationScope) {
          setListState(refreshed ? 'ready' : 'failed')
        }
        return true
      } finally {
        finishVisibilityMutation(mutationScope, mutation)
        if (currentMutationScopeRef.current === mutationScope) {
          setIsToggling(false)
        }
      }
    },
    [mutationScope, refreshTargetRepo, repoId, updateTargetRepo]
  )

  const handleUseDefault = useCallback(
    async (source: WorktreeVisibilitySourceRow) => {
      if (!repo) {
        return
      }
      const mutation = createWorktreeVisibilityUseGlobalMutation(repo, source, visibilityDefaults)
      await commitSourceUpdate(mutation.updates, mutation.isAccepted)
    },
    [commitSourceUpdate, repo, visibilityDefaults]
  )

  const handleSourceToggle = useCallback(
    async (source: WorktreeVisibilitySourceRow, checked: boolean) => {
      if (!repo) {
        return
      }
      const visibility = checked ? 'show' : 'hide'
      if (
        shouldUseGlobalWorktreeVisibility(
          repo,
          source,
          visibility,
          visibilityDefaults,
          removableSourceIds
        )
      ) {
        await handleUseDefault(source)
        return
      }
      const mutation = createWorktreeVisibilitySourceMutation(
        repo,
        source,
        visibility,
        visibilityDefaults
      )
      await commitSourceUpdate(mutation.updates, mutation.isAccepted)
    },
    [commitSourceUpdate, handleUseDefault, removableSourceIds, repo, visibilityDefaults]
  )

  const handleAddSource = useCallback(
    async (rootPath: string): Promise<WorktreeVisibilitySourceAddResult> => {
      if (!repo) {
        return 'save-failed'
      }
      const existing = normalizeCustomWorktreeVisibilitySources(
        repo.customWorktreeVisibilitySources
      )
      if ((existing?.length ?? 0) >= MAX_CUSTOM_WORKTREE_VISIBILITY_SOURCES) {
        return 'limit'
      }
      const id = crypto.randomUUID().replaceAll('-', '')
      const candidate = normalizeCustomWorktreeVisibilitySources([{ id, rootPath }])?.[0]
      if (!candidate) {
        return 'invalid-path'
      }
      if (isDuplicateWorktreeVisibilitySource(repo, visibilityDefaults, candidate)) {
        return 'duplicate-path'
      }
      const next = normalizeCustomWorktreeVisibilitySources([...(existing ?? []), candidate])
      if (!next || next.length !== (existing?.length ?? 0) + 1) {
        return 'duplicate-path'
      }
      const saved = await commitSourceUpdate(
        {
          customWorktreeVisibilitySources: next,
          worktreeVisibilitySourcePreferences: buildWorktreeSourcePreferenceUpdate(
            repo,
            { kind: 'custom', id },
            'hide'
          )
        },
        (latestRepo) =>
          normalizeCustomWorktreeVisibilitySources(
            latestRepo.customWorktreeVisibilitySources
          )?.some((source) => source.id === id) === true &&
          effectiveCustomWorktreeSourceVisibility(latestRepo, id, visibilityDefaults) === 'hide'
      )
      return saved ? 'added' : 'save-failed'
    },
    [commitSourceUpdate, repo, visibilityDefaults]
  )

  const handleRemoveSource = useCallback(
    async (source: CustomWorktreeVisibilitySource) => {
      if (!repo) {
        return
      }
      const next = (
        normalizeCustomWorktreeVisibilitySources(repo.customWorktreeVisibilitySources) ?? []
      ).filter((candidate) => candidate.id !== source.id)
      await commitSourceUpdate(
        {
          customWorktreeVisibilitySources: next,
          worktreeVisibilitySourcePreferences: removeCustomWorktreeSourcePreference(repo, source.id)
        },
        (latestRepo) =>
          !normalizeCustomWorktreeVisibilitySources(
            latestRepo.customWorktreeVisibilitySources
          )?.some((candidate) => candidate.id === source.id) &&
          normalizeWorktreeVisibilitySourcePreferences(
            latestRepo.worktreeVisibilitySourcePreferences
          )?.custom?.[source.id] === undefined
      )
    },
    [commitSourceUpdate, repo]
  )

  if (!isOpen || !repo || !isGitRepoKind(repo)) {
    return null
  }

  return (
    <Dialog open onOpenChange={(open) => !open && closeModal()}>
      <DialogContent className="scrollbar-sleek max-h-[calc(100vh-6rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-1.5">
            <DialogTitle>
              {translate(
                'auto.components.sidebar.WorktreeVisibilityDialog.83a5ba8dd1',
                'Non-Orca worktrees'
              )}
            </DialogTitle>
            <WorktreeVisibilityHelpPopover />
          </div>
          <DialogDescription>{repo.displayName}</DialogDescription>
        </DialogHeader>

        <WorktreeVisibilitySourceList
          repo={repo}
          worktrees={detected?.authoritative ? detected.worktrees : []}
          visibilityDefaults={visibilityDefaults}
          removableSourceIds={removableSourceIds}
          disabled={effectiveBusyPath !== null || effectivelyToggling || listState === 'checking'}
          onAdd={handleAddSource}
          onRemove={handleRemoveSource}
          onToggle={handleSourceToggle}
          onUseDefault={handleUseDefault}
        />

        <WorktreeVisibilityGlobalSettingsLink repo={repo} visibilityDefaults={visibilityDefaults} />

        <WorktreeVisibilityScanStatus
          state={listState}
          retryDisabled={effectiveBusyPath !== null || effectivelyToggling}
          onRetry={handleRetryList}
        />

        <HiddenWorktreeRecoveryList
          repo={repo}
          detected={detected}
          listState={listState}
          busyPath={effectiveBusyPath}
          toggling={effectivelyToggling}
          onShow={handleShowWorktree}
        />

        {actionState?.error ? (
          <p className="text-xs text-destructive" role="alert">
            {actionState.error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

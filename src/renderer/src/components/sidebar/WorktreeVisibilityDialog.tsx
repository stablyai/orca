import type { Repo, CustomWorktreeVisibilitySource } from '../../../../shared/repo-types'

import type { NewExternalWorktreesInboxActionState } from './new-external-worktrees-inbox-actions'
import React, { useCallback, useMemo } from 'react'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { getHostContextLabel } from '../../../../shared/worktree/host-context-labels'
import { useWorktreeVisibilityRecovery } from './use-worktree-visibility-recovery'

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

import WorktreeVisibilityHelpPopover from './WorktreeVisibilityHelpPopover'
import {
  resolveWorktreeVisibilityTargets,
  useWorktreeVisibilityHostActions
} from './worktree-visibility-host-target'
import {
  type ActiveVisibilityMutation,
  finishVisibilityMutation,
  getActiveVisibilityMutation,
  startVisibilityMutation
} from './worktree-visibility-mutation-fence'
import WorktreeVisibilitySourceList, {
  type WorktreeVisibilitySourceRow,
  type WorktreeVisibilitySourceAddResult
} from './WorktreeVisibilitySourceList'

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
import { createBrowserUuid } from '@/lib/browser-uuid'
import { selectDetectedWorktreesByRepo } from '@/store/workspace-record-selectors'

export default function WorktreeVisibilityDialog(): React.JSX.Element | null {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const repos = useAppStore((s) => s.repos)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const detectedWorktreesByRepo = useAppStore((s) => selectDetectedWorktreesByRepo(s))
  const settings = useAppStore((s) => s.settings)
  const isOpen = activeModal === 'worktree-visibility'
  const repoId = typeof modalData.repoId === 'string' ? modalData.repoId : ''
  const {
    detected,
    repo,
    requestedHostId,
    scope: mutationScope,
    entries,
    scanTargets
  } = useMemo(
    () =>
      resolveWorktreeVisibilityTargets(
        { repos, settings, detectedWorktreesByRepo },
        repoId,
        modalData.hostId,
        modalData.recoveryTargets
      ),
    [repos, settings, detectedWorktreesByRepo, repoId, modalData.hostId, modalData.recoveryTargets]
  )
  const {
    targetStates,
    currentMutationScopeRef,
    setTargetState,
    handleRetryList,
    handleShowWorktree
  } = useWorktreeVisibilityRecovery({
    isOpen,
    scanTargets,
    fetchWorktrees,
    updateRepo
  })
  const setActionState = useCallback(
    (actionState: NewExternalWorktreesInboxActionState | null) =>
      setTargetState(mutationScope, { actionState }),
    [mutationScope, setTargetState]
  )
  const setIsToggling = useCallback(
    (isToggling: boolean) => setTargetState(mutationScope, { isToggling }),
    [mutationScope, setTargetState]
  )
  const setListState = useCallback(
    (listState: 'checking' | 'ready' | 'failed') => setTargetState(mutationScope, { listState }),
    [mutationScope, setTargetState]
  )
  const sourceState = targetStates.get(mutationScope)
  const activeMutation = getActiveVisibilityMutation(mutationScope)
  const effectiveBusyPath =
    sourceState?.busyPath ?? (activeMutation?.kind === 'row' ? activeMutation.path : null)
  const effectivelyToggling = sourceState?.isToggling || activeMutation?.kind === 'toggle'
  const sourceListState = sourceState?.listState ?? 'checking'
  const recoveryEntries = entries.flatMap((entry) =>
    entry.repo
      ? [
          {
            repo: entry.repo,
            detected: entry.detected,
            listState: targetStates.get(entry.scope)?.listState ?? ('checking' as const),
            busyPath: targetStates.get(entry.scope)?.busyPath ?? null,
            toggling: targetStates.get(entry.scope)?.isToggling ?? false
          }
        ]
      : []
  )
  const listState = recoveryEntries.some((entry) => entry.listState === 'checking')
    ? 'checking'
    : recoveryEntries.some((entry) => entry.listState === 'failed') ||
        recoveryEntries.length < entries.length
      ? 'failed'
      : 'ready'
  const visibilityDefaults = useRepoOwnerVisibilityDefaults(repo ?? null)
  const removableSourceIds = useMemo(
    () => getRepoCustomWorktreeVisibilitySourceIds(repo ?? null),
    [repo]
  )
  const { refreshTargetRepo, updateTargetRepo } = useWorktreeVisibilityHostActions(
    fetchWorktrees,
    updateRepo,
    requestedHostId
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
          if (
            currentMutationScopeRef.current.has(mutationScope) &&
            getActiveVisibilityMutation(mutationScope) === mutation
          ) {
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
        if (
          currentMutationScopeRef.current.has(mutationScope) &&
          getActiveVisibilityMutation(mutationScope) === mutation
        ) {
          setListState(refreshed ? 'ready' : 'failed')
        }
        return true
      } finally {
        const ownsMutation = getActiveVisibilityMutation(mutationScope) === mutation
        finishVisibilityMutation(mutationScope, mutation)
        if (currentMutationScopeRef.current.has(mutationScope) && ownsMutation) {
          setIsToggling(false)
        }
      }
    },
    [
      mutationScope,
      refreshTargetRepo,
      repoId,
      updateTargetRepo,
      setActionState,
      setIsToggling,
      setListState,
      currentMutationScopeRef
    ]
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
      const id = createBrowserUuid().replaceAll('-', '')
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

  if (
    !isOpen ||
    (!repo && recoveryEntries.length === 0) ||
    (repo && !isGitRepoKind(repo) && recoveryEntries.length === 0)
  ) {
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
          <DialogDescription>
            {repo
              ? `${repo.displayName} · ${repo.path}${entries.length > 1 ? ` · ${getHostContextLabel(getRepoExecutionHostId(repo))}` : ''}`
              : repoId}
          </DialogDescription>
        </DialogHeader>

        {repo && isGitRepoKind(repo) ? (
          <>
            <WorktreeVisibilitySourceList
              repo={repo}
              worktrees={detected?.authoritative ? detected.worktrees : []}
              visibilityDefaults={visibilityDefaults}
              removableSourceIds={removableSourceIds}
              disabled={
                effectiveBusyPath !== null || effectivelyToggling || sourceListState === 'checking'
              }
              onAdd={handleAddSource}
              onRemove={handleRemoveSource}
              onToggle={handleSourceToggle}
              onUseDefault={handleUseDefault}
            />

            <WorktreeVisibilityGlobalSettingsLink
              repo={repo}
              visibilityDefaults={visibilityDefaults}
            />
          </>
        ) : null}

        <WorktreeVisibilityScanStatus
          state={listState}
          retryDisabled={effectiveBusyPath !== null || effectivelyToggling}
          onRetry={handleRetryList}
        />

        <HiddenWorktreeRecoveryList
          entries={recoveryEntries}
          listState={listState}
          onShow={handleShowWorktree}
        />
        {[...targetStates].flatMap(([scope, state]) =>
          currentMutationScopeRef.current.has(scope) && state.actionState?.error
            ? [
                <p key={scope} className="text-xs text-destructive" role="alert">
                  {state.actionState.error}
                </p>
              ]
            : []
        )}
      </DialogContent>
    </Dialog>
  )
}

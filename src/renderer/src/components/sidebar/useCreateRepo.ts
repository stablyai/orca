// Create-project flow hook for AddRepoDialog (orca#763), split from
// AddRepoCreateStep so the create-state machine stays scoped and testable.
import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { markOnboardingProjectAdded } from '@/lib/onboarding-project-checklist'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import type { RepoKind } from './create-project-defaults'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { upsertAddedRepoWithProjectHostSetup } from './add-repo-store-upsert'

export function useCreateRepo(
  fetchWorktrees: (
    repoId: string,
    options?: { requireAuthoritative?: boolean }
  ) => Promise<boolean>,
  closeModal: () => void,
  onGitRepoReady?: (repoId: string) => void | Promise<void>,
  options: {
    hostId?: string | null
    runtimeEnvironmentId?: string | null
    sshTargetId?: string | null
  } = {}
) {
  const [createName, setCreateName] = useState('')
  const [createParent, setCreateParent] = useState('')
  const [createKind, setCreateKind] = useState<RepoKind>('git')
  const [createError, setCreateError] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const mountedRef = useMountedRef()
  const hostToken = options.hostId ?? options.sshTargetId ?? ''
  const hostTokenRef = useRef(hostToken)
  hostTokenRef.current = hostToken

  // Why: monotonic ID so stale create callbacks can detect they were superseded
  // when the user clicks Back or closes the dialog mid-create. Mirrors the
  // cloneGenRef pattern in AddRepoDialog.
  const createGenRef = useRef(0)

  const resetCreateState = useCallback(() => {
    createGenRef.current++
    setCreateName('')
    setCreateParent('')
    setCreateKind('git')
    setCreateError(null)
    setIsCreating(false)
  }, [])

  const handlePickParent = useCallback(async (): Promise<string | null> => {
    if (options.sshTargetId) {
      // Why: the native picker can only browse the client machine. SSH create
      // uses a host path typed by the user until remote folder picking exists.
      toast.error(
        translate(
          'auto.components.sidebar.AddRepoCreateStep.ssh_parent_manual',
          'Enter an SSH parent path.'
        )
      )
      return null
    }
    if (options.runtimeEnvironmentId?.trim()) {
      // Why: the native folder picker returns a client-local path. Runtime
      // project creation needs an explicit host parent path.
      toast.error(
        translate(
          'auto.components.sidebar.AddRepoCreateStep.875dda0995',
          'Enter a host parent path.'
        )
      )
      return null
    }
    const gen = createGenRef.current
    const dir = await window.api.repos.pickDirectory()
    if (dir && gen === createGenRef.current && mountedRef.current) {
      setCreateParent(dir)
      setCreateError(null)
      return dir
    }
    return null
  }, [mountedRef, options.runtimeEnvironmentId, options.sshTargetId])

  const handleCreate = useCallback(async () => {
    const name = createName.trim()
    const parentPath = createParent.trim()
    if (!name || !parentPath) {
      return
    }
    const requestHostToken = hostTokenRef.current
    const gen = ++createGenRef.current
    setIsCreating(true)
    setCreateError(null)
    try {
      const target = options.runtimeEnvironmentId?.trim()
        ? { kind: 'environment' as const, environmentId: options.runtimeEnvironmentId.trim() }
        : getActiveRuntimeTarget({
            ...useAppStore.getState().settings,
            activeRuntimeEnvironmentId: null
          })
      const result = options.sshTargetId
        ? await window.api.repos.createRemote({
            connectionId: options.sshTargetId,
            parentPath,
            name,
            kind: createKind
          })
        : target.kind === 'environment'
          ? await callRuntimeRpc<{ repo: Repo } | { error: string }>(
              target,
              'repo.create',
              {
                parentPath,
                name,
                kind: createKind
              },
              { timeoutMs: 60_000 }
            )
          : await window.api.repos.create({
              parentPath,
              name,
              kind: createKind
            })
      // Why: if the user closed the dialog or clicked Back mid-create,
      // createGenRef was bumped by resetCreateState. Ignore stale results.
      if (
        gen !== createGenRef.current ||
        requestHostToken !== hostTokenRef.current ||
        !mountedRef.current
      ) {
        return
      }
      if ('error' in result) {
        setCreateError(result.error)
        return
      }
      const repo = result.repo
      const state = useAppStore.getState()
      const existingIdx = state.repos.findIndex((r) => r.id === repo.id)
      // Why: the IPC handler dedupes by path (see repos:create) and returns
      // the existing repo unchanged. If its ID is already in our store, the
      // handler took the dedup path — no new project was created, so don't
      // claim one was.
      const wasDeduped = existingIdx !== -1
      upsertAddedRepoWithProjectHostSetup(repo)
      if (wasDeduped) {
        toast.info(
          translate(
            'auto.components.sidebar.AddRepoCreateStep.2c12db1511',
            'Project already added'
          ),
          {
            description: repo.displayName
          }
        )
      } else {
        toast.success(
          translate('auto.components.sidebar.AddRepoCreateStep.5e97f0c4b9', 'Project created'),
          {
            description: repo.displayName
          }
        )
      }
      if (isGitRepoKind(repo)) {
        // Why: Git repos use the shared default-checkout completion path.
        // Why: if refresh is temporarily non-authoritative, the shared opener
        // still reveals the project so the user is not left in a completed add flow.
        await fetchWorktrees(repo.id, { requireAuthoritative: true })
        if (
          gen !== createGenRef.current ||
          requestHostToken !== hostTokenRef.current ||
          !mountedRef.current
        ) {
          return
        }
        await onGitRepoReady?.(repo.id)
      } else {
        // Why: folder repos skip the Git default-checkout handoff, so activate the synthetic
        // root workspace before closing. Matches addNonGitFolder's behavior.
        await fetchWorktrees(repo.id)
        if (
          gen !== createGenRef.current ||
          requestHostToken !== hostTokenRef.current ||
          !mountedRef.current
        ) {
          return
        }
        const folderWorktree = useAppStore.getState().worktreesByRepo[repo.id]?.[0]
        if (folderWorktree) {
          activateAndRevealWorktree(folderWorktree.id, { sidebarRevealBehavior: 'auto' })
        }
        await markOnboardingProjectAdded('addedFolder')
        closeModal()
      }
    } catch (err) {
      if (
        gen !== createGenRef.current ||
        requestHostToken !== hostTokenRef.current ||
        !mountedRef.current
      ) {
        return
      }
      setCreateError(extractIpcErrorMessage(err, String(err)))
    } finally {
      // Why: only clear the loading state if this invocation is still current;
      // a superseded create must not flip the flag back off for a new flow.
      if (
        gen === createGenRef.current &&
        requestHostToken === hostTokenRef.current &&
        mountedRef.current
      ) {
        setIsCreating(false)
      }
    }
  }, [
    createName,
    createParent,
    createKind,
    fetchWorktrees,
    mountedRef,
    closeModal,
    onGitRepoReady,
    options.runtimeEnvironmentId,
    options.sshTargetId
  ])

  return {
    createName,
    createParent,
    createKind,
    createError,
    isCreating,
    setCreateName,
    setCreateParent,
    setCreateKind,
    setCreateError,
    resetCreateState,
    handlePickParent,
    handleCreate
  }
}

import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { markOnboardingProjectAdded } from '@/lib/onboarding-project-checklist'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/repo-types'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { upsertAddedRepoWithProjectHostSetup } from './add-repo-store-upsert'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { addedRepoRefreshOptions, resolveAddRepoRuntimeTarget } from './add-repo-runtime-owner'
import { refreshWslRegistrationAfterFailure } from '@/store/repos/repo-owner-host-readiness'
import { getWorktreeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  readWslHostWindowsDriveRefusal,
  type WslHostWindowsDriveRefusal
} from '../../../../shared/wsl-host-windows-drive-refusal'

export function useCreateRepo(
  fetchWorktrees: (
    repoId: string,
    options?: {
      requireAuthoritative?: boolean
      executionHostId?: ExecutionHostId
    }
  ) => Promise<boolean>,
  closeModal: () => void,
  onGitRepoReady?: (repoId: string, executionHostId?: ExecutionHostId) => void | Promise<void>,
  options: {
    hostId?: string | null
    runtimeEnvironmentId?: string | null
    onWindowsDriveRefusal?: (refusal: WslHostWindowsDriveRefusal) => void
  } = {}
) {
  const { onWindowsDriveRefusal } = options
  const [createName, setCreateName] = useState('')
  const [createParent, setCreateParent] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const mountedRef = useMountedRef()
  const hostToken = options.hostId ?? ''
  const hostTokenRef = useRef(hostToken)
  hostTokenRef.current = hostToken

  // Invalidate callbacks when Back or close supersedes the create flow.
  const createGenRef = useRef(0)

  const resetCreateState = useCallback(() => {
    createGenRef.current++
    setCreateName('')
    setCreateParent('')
    setCreateError(null)
    setIsCreating(false)
  }, [])

  const handlePickParent = useCallback(async (): Promise<string | null> => {
    if (options.runtimeEnvironmentId?.trim()) {
      // Native pickers return client-local paths; remote creation requires an explicit host parent path.
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
  }, [mountedRef, options.runtimeEnvironmentId])

  const handleCreate = useCallback(async () => {
    const name = createName.trim()
    const parentPath = createParent.trim()
    // Block unresolved hosts so creation cannot silently fall back to this computer.
    if (!name || !parentPath || options.hostId === null) {
      return
    }
    const requestHostToken = hostTokenRef.current
    const gen = ++createGenRef.current
    const isCurrent = (): boolean =>
      gen === createGenRef.current &&
      requestHostToken === hostTokenRef.current &&
      mountedRef.current
    setIsCreating(true)
    setCreateError(null)
    try {
      const target = resolveAddRepoRuntimeTarget(options.runtimeEnvironmentId)
      const createKind = 'git' as const
      const result =
        target.kind === 'environment'
          ? await callRuntimeRpc<{ repo: Repo } | { error: string; windowsDriveRefusal?: unknown }>(
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
      if (!isCurrent()) {
        return
      }
      if ('error' in result) {
        const refusal =
          'windowsDriveRefusal' in result
            ? readWslHostWindowsDriveRefusal(result.windowsDriveRefusal)
            : null
        if (refusal && onWindowsDriveRefusal) {
          onWindowsDriveRefusal(refusal)
        } else {
          setCreateError(result.error)
        }
        return
      }
      const { alreadyPresent: wasDeduped, repo } = await upsertAddedRepoWithProjectHostSetup(
        result.repo,
        {
          runtimeEnvironmentId: options.runtimeEnvironmentId
        }
      )
      // Existing host-qualified store identity indicates path deduplication; do not claim a new project was created.
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
      const ownerOptions = addedRepoRefreshOptions(repo)
      if (isGitRepoKind(repo)) {
        // Reveal persisted projects even after transient non-authoritative refreshes.
        await fetchWorktrees(repo.id, ownerOptions)
        if (!isCurrent()) {
          return
        }
        await onGitRepoReady?.(repo.id, ownerOptions.executionHostId)
      } else {
        // Folder projects activate their synthetic root before close, matching the add-folder path.
        await fetchWorktrees(repo.id, { executionHostId: ownerOptions.executionHostId })
        if (!isCurrent()) {
          return
        }
        const folderWorktree = selectWorktreesByRepo(useAppStore.getState())[repo.id]?.find(
          (worktree) => getWorktreeExecutionHostId(worktree, repo) === ownerOptions.executionHostId
        )
        if (folderWorktree) {
          activateAndRevealWorktree(folderWorktree.id, {
            sidebarRevealBehavior: 'auto',
            executionHostId: ownerOptions.executionHostId
          })
        }
        await markOnboardingProjectAdded('addedFolder')
        closeModal()
      }
    } catch (err) {
      await refreshWslRegistrationAfterFailure(useAppStore.getState, createParent)
      if (!isCurrent()) {
        return
      }
      setCreateError(extractIpcErrorMessage(err, String(err)))
    } finally {
      // Only the current invocation may clear loading; stale results must not hide a newer create flow.
      if (isCurrent()) {
        setIsCreating(false)
      }
    }
  }, [
    createName,
    createParent,
    fetchWorktrees,
    mountedRef,
    closeModal,
    onGitRepoReady,
    onWindowsDriveRefusal,
    options.hostId,
    options.runtimeEnvironmentId
  ])

  return {
    createName,
    createParent,
    createError,
    isCreating,
    setCreateName,
    setCreateParent,
    setCreateError,
    resetCreateState,
    handlePickParent,
    handleCreate
  }
}

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry-events'
import type { Repo } from '../../../../shared/types'
import { getCloneDestinationAutoFill } from './clone-defaults'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { upsertAddedRepoWithProjectHostSetup } from './add-repo-store-upsert'

export function useAddRepoCloneFlow({
  step,
  activeRuntimeEnvironmentId,
  sshTargetId,
  workspaceDir,
  fetchWorktrees,
  onGitRepoReady
}: {
  step: AddRepoDialogStep
  activeRuntimeEnvironmentId: string | null | undefined
  sshTargetId?: string | null
  workspaceDir: string | null | undefined
  fetchWorktrees: (repoId: string, options?: { requireAuthoritative?: boolean }) => Promise<unknown>
  onGitRepoReady: (repoId: string, source: AddRepoExistingWorkspaceSource) => Promise<void>
}): {
  cloneUrl: string
  cloneDestination: string
  cloneError: string | null
  cloneProgress: { phase: string; percent: number } | null
  isCloning: boolean
  setCloneUrl: Dispatch<SetStateAction<string>>
  setCloneDestination: Dispatch<SetStateAction<string>>
  setCloneError: Dispatch<SetStateAction<string | null>>
  resetCloneFlow: () => void
  handlePickDestination: () => Promise<void>
  handleClone: () => Promise<void>
} {
  const [cloneUrl, setCloneUrl] = useState('')
  const [cloneDestination, setCloneDestination] = useState('')
  const [isCloning, setIsCloning] = useState(false)
  const [cloneError, setCloneError] = useState<string | null>(null)
  const [cloneProgress, setCloneProgress] = useState<{ phase: string; percent: number } | null>(
    null
  )
  const hostToken = `${activeRuntimeEnvironmentId?.trim() ?? ''}:${sshTargetId?.trim() ?? ''}`
  const hostTokenRef = useRef(hostToken)
  hostTokenRef.current = hostToken
  // Why: monotonic ID so stale clone callbacks can detect they were superseded.
  const cloneGenRef = useRef(0)
  // Why: track whether we've already auto-filled for this entry into the clone step,
  // so a late settings hydration still gets a chance to set the default.
  const cloneStepAutoFilledRef = useRef(false)

  useEffect(() => {
    if (!isCloning) {
      return
    }
    return window.api.repos.onCloneProgress(setCloneProgress)
  }, [isCloning])

  const cloneDestinationAutoFill = getCloneDestinationAutoFill({
    step,
    cloneDestination,
    activeRuntimeEnvironmentId,
    sshTargetId,
    workspaceDir,
    cloneStepAutoFilled: cloneStepAutoFilledRef.current
  })
  if (step !== 'clone') {
    cloneStepAutoFilledRef.current = false
  } else if (cloneDestinationAutoFill) {
    // Why: late settings hydration should still seed the local clone path,
    // but runtime/server clone flows must keep their destination user-entered.
    cloneStepAutoFilledRef.current = true
    setCloneDestination(cloneDestinationAutoFill.destination)
  }

  const resetCloneFlow = useCallback((): void => {
    cloneGenRef.current++
    setCloneUrl('')
    setCloneDestination('')
    setIsCloning(false)
    setCloneError(null)
    setCloneProgress(null)
  }, [])

  const handlePickDestination = useCallback(async (): Promise<void> => {
    if (activeRuntimeEnvironmentId?.trim() || sshTargetId?.trim()) {
      // Why: the native folder picker returns a client-local path. Runtime
      // and SSH clone destinations must be typed as paths on that host.
      toast.error(
        translate(
          'auto.components.sidebar.useAddRepoCloneFlow.0dc4d1b657',
          'Enter a host path for the clone destination.'
        )
      )
      return
    }
    const gen = cloneGenRef.current
    const dir = await window.api.repos.pickDirectory()
    if (dir && gen === cloneGenRef.current) {
      setCloneDestination(dir)
      setCloneError(null)
    }
  }, [activeRuntimeEnvironmentId, sshTargetId])

  const handleClone = useCallback(async (): Promise<void> => {
    const trimmedUrl = cloneUrl.trim()
    if (!trimmedUrl || !cloneDestination.trim()) {
      return
    }
    const requestHostToken = hostTokenRef.current
    const gen = ++cloneGenRef.current
    setIsCloning(true)
    setCloneError(null)
    setCloneProgress(null)
    try {
      const target = activeRuntimeEnvironmentId?.trim()
        ? { kind: 'environment' as const, environmentId: activeRuntimeEnvironmentId.trim() }
        : getActiveRuntimeTarget({
            ...useAppStore.getState().settings,
            activeRuntimeEnvironmentId: null
          })
      const repo = sshTargetId?.trim()
        ? await window.api.repos.cloneRemote({
            connectionId: sshTargetId.trim(),
            url: trimmedUrl,
            destination: cloneDestination.trim()
          })
        : target.kind === 'environment'
          ? (
              await callRuntimeRpc<{ repo: Repo }>(
                target,
                'repo.clone',
                {
                  url: trimmedUrl,
                  destination: cloneDestination.trim()
                },
                { timeoutMs: 10 * 60_000 }
              )
            ).repo
          : ((await window.api.repos.clone({
              url: trimmedUrl,
              destination: cloneDestination.trim()
            })) as Repo)
      if (gen !== cloneGenRef.current || requestHostToken !== hostTokenRef.current) {
        return
      }
      toast.success(
        translate('auto.components.sidebar.useAddRepoCloneFlow.4d0013cc93', 'Repository cloned'),
        { description: repo.displayName }
      )
      upsertAddedRepoWithProjectHostSetup(repo)
      // Why: once the repo exists, a transient non-authoritative refresh
      // should fall through to project reveal instead of leaving the add flow open.
      await fetchWorktrees(repo.id, { requireAuthoritative: true })
      if (gen !== cloneGenRef.current || requestHostToken !== hostTokenRef.current) {
        return
      }
      await onGitRepoReady(repo.id, 'clone_url')
    } catch (err) {
      if (gen !== cloneGenRef.current || requestHostToken !== hostTokenRef.current) {
        return
      }
      const message = extractIpcErrorMessage(err, String(err))
      setCloneError(message)
    } finally {
      if (gen === cloneGenRef.current && requestHostToken === hostTokenRef.current) {
        setIsCloning(false)
      }
    }
  }, [
    activeRuntimeEnvironmentId,
    cloneUrl,
    cloneDestination,
    fetchWorktrees,
    onGitRepoReady,
    sshTargetId
  ])

  return {
    cloneUrl,
    cloneDestination,
    cloneError,
    cloneProgress,
    isCloning,
    setCloneUrl,
    setCloneDestination,
    setCloneError,
    resetCloneFlow,
    handlePickDestination,
    handleClone
  }
}

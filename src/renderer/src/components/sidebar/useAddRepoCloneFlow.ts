import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry-events'
import { getCloneDestinationAutoFill } from './clone-defaults'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import { translate } from '@/i18n/i18n'
import type { CloneTaskBackend } from '@/store/slices/clone-tasks'

export function useAddRepoCloneFlow({
  step,
  activeRuntimeEnvironmentId,
  sshTargetId,
  workspaceDir,
  onGitRepoReady
}: {
  step: AddRepoDialogStep
  activeRuntimeEnvironmentId: string | null | undefined
  sshTargetId?: string | null
  workspaceDir: string | null | undefined
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
  const [cloneError, setCloneError] = useState<string | null>(null)
  // Why: the clone lifecycle now lives in the clone-tasks store slice so it can
  // outlive this dialog. The dialog only tracks which task it started, and reads
  // that task's live progress/status back from the store.
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const cloneTask = useAppStore((s) => (activeTaskId ? s.cloneTasksById[activeTaskId] : undefined))
  // Why: guard the one-shot success handoff so navigation runs exactly once.
  const navigatedTaskRef = useRef<string | null>(null)
  // Why: track whether we've already auto-filled for this entry into the clone step,
  // so a late settings hydration still gets a chance to set the default.
  const cloneStepAutoFilledRef = useRef(false)

  const isCloning = cloneTask?.status === 'cloning'
  const cloneProgress =
    cloneTask?.percent !== undefined
      ? { phase: cloneTask.phase ?? '', percent: cloneTask.percent }
      : null

  // Why: surface the store task's outcome through the dialog's error line, and
  // run the navigation handoff once the clone this dialog started succeeds.
  useEffect(() => {
    if (!activeTaskId || !cloneTask) {
      return
    }
    if (cloneTask.status === 'error') {
      setCloneError(cloneTask.error ?? null)
      return
    }
    if (cloneTask.status === 'success' && cloneTask.repoId) {
      if (navigatedTaskRef.current === activeTaskId) {
        return
      }
      navigatedTaskRef.current = activeTaskId
      const repoId = cloneTask.repoId
      // Why: the slice already ran the authoritative worktree fetch before
      // marking success; here we only run the dialog's navigation handoff.
      void (async () => {
        await onGitRepoReady(repoId, 'clone_url')
        // Why: the repo is revealed; drop the finished task so no sidebar row lingers.
        useAppStore.getState().dismissCloneTask(activeTaskId)
        setActiveTaskId(null)
      })()
    }
    // Why: the worktree fetch runs inside runCloneTask (store slice), so this
    // effect only performs the dialog's navigation handoff on success.
  }, [activeTaskId, cloneTask, onGitRepoReady])

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
    // Why: closing/backing out of the dialog no longer aborts the clone — it
    // hands the in-flight task off to the sidebar so it keeps running.
    if (activeTaskId) {
      useAppStore.getState().backgroundCloneTask(activeTaskId)
    }
    setActiveTaskId(null)
    navigatedTaskRef.current = null
    setCloneUrl('')
    setCloneDestination('')
    setCloneError(null)
  }, [activeTaskId])

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
    const dir = await window.api.repos.pickDirectory()
    if (dir) {
      setCloneDestination(dir)
      setCloneError(null)
    }
  }, [activeRuntimeEnvironmentId, sshTargetId])

  const handleClone = useCallback(async (): Promise<void> => {
    const trimmedUrl = cloneUrl.trim()
    const trimmedDestination = cloneDestination.trim()
    if (!trimmedUrl || !trimmedDestination) {
      return
    }
    setCloneError(null)
    const trimmedSshTargetId = sshTargetId?.trim()
    const trimmedEnvironmentId = activeRuntimeEnvironmentId?.trim()
    let backend: CloneTaskBackend = 'local'
    if (trimmedSshTargetId) {
      backend = 'ssh'
    } else if (
      trimmedEnvironmentId ||
      getActiveRuntimeTarget(useAppStore.getState().settings).kind === 'environment'
    ) {
      backend = 'environment'
    }
    const environmentId =
      backend === 'environment'
        ? (trimmedEnvironmentId ??
          useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
          undefined)
        : undefined
    navigatedTaskRef.current = null
    const taskId = useAppStore.getState().startCloneTask({
      url: trimmedUrl,
      destination: trimmedDestination,
      backend,
      connectionId: trimmedSshTargetId || undefined,
      environmentId
    })
    setActiveTaskId(taskId)
  }, [activeRuntimeEnvironmentId, cloneUrl, cloneDestination, sshTargetId])

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

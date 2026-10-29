import { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { addRuntimeSshRepo } from '@/runtime/runtime-ssh-target-management'
import { connectRuntimeEnvironmentSshTarget } from '@/runtime/runtime-environment-ssh-state'
import {
  loadServerSshTargets,
  withServerSshStates,
  type RemoteRepoTarget
} from './add-repo-server-ssh-targets'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { upsertAddedRepoWithProjectHostSetup } from './add-repo-store-upsert'
import { worktreeRefreshOptions } from './add-repo-runtime-owner'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export function useRemoteRepo(
  fetchWorktrees: (
    repoId: string,
    options?: {
      requireAuthoritative?: boolean
      executionHostId?: ExecutionHostId
    }
  ) => Promise<unknown>,
  setStep: (step: 'add' | 'clone' | 'remote' | 'create' | 'nested') => void,
  closeModal: () => void,
  onGitRepoReady: (repoId: string, executionHostId?: ExecutionHostId) => void | Promise<void>,
  /** A paired server: its own SSH hosts are listed, browsed and added by that server only. */
  serverEnvironmentId: string | null
) {
  const [sshTargets, setSshTargets] = useState<RemoteRepoTarget[]>([])
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null)
  const [remotePath, setRemotePath] = useState('~/')
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [isAddingRemote, setIsAddingRemote] = useState(false)
  const remoteGenRef = useRef(0)
  const mountedRef = useMountedRef()

  const resetRemoteState = useCallback(() => {
    remoteGenRef.current++
    setSshTargets([])
    setSelectedTargetId(null)
    setRemotePath('~/')
    setRemoteError(null)
    setIsAddingRemote(false)
  }, [])

  const handleOpenRemoteStep = useCallback(
    async (preferredTargetId?: string | null) => {
      if (!serverEnvironmentId) {
        return
      }
      const gen = ++remoteGenRef.current
      setStep('remote')
      try {
        const withState = await loadServerSshTargets(serverEnvironmentId)
        if (gen !== remoteGenRef.current) {
          return
        }
        setSshTargets(withState)
        const preferred = preferredTargetId
          ? withState.find((t) => t.id === preferredTargetId)
          : undefined
        const connected = withState.find((t) => t.state?.status === 'connected')
        if (preferred) {
          setSelectedTargetId(preferred.id)
          return
        }
        if (connected) {
          setSelectedTargetId(connected.id)
        }
      } catch (error) {
        if (gen !== remoteGenRef.current) {
          return
        }
        setSshTargets([])
        setRemoteError(extractIpcErrorMessage(error, String(error)))
      }
    },
    [serverEnvironmentId, setStep]
  )

  const serverSshStates = useAppStore((s) =>
    serverEnvironmentId
      ? s.sshStateByEnvironment.get(serverEnvironmentId)?.connectionStates
      : undefined
  )
  // Derive display from pushed server SSH state while the step remains open.
  const displayedSshTargets = useMemo(
    () => withServerSshStates(sshTargets, serverSshStates),
    [serverSshStates, sshTargets]
  )

  const handleConnectTarget = useCallback(
    async (targetId: string) => {
      if (!serverEnvironmentId) {
        return
      }
      try {
        const state = await connectRuntimeEnvironmentSshTarget(serverEnvironmentId, targetId)
        if (state) {
          setSshTargets((prev) => prev.map((t) => (t.id === targetId ? { ...t, state } : t)))
          setSelectedTargetId((curr) => (state.status === 'connected' ? (curr ?? targetId) : curr))
        }
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : translate('auto.components.sidebar.AddRepoSteps.3e64e8a70d', 'Connection failed')
        )
      }
    },
    [serverEnvironmentId]
  )

  const handleAddRemoteRepo = useCallback(async () => {
    if (!serverEnvironmentId || !selectedTargetId || !remotePath.trim()) {
      return
    }

    const trimmedRemotePath = remotePath.trim()
    const gen = ++remoteGenRef.current
    setIsAddingRemote(true)
    setRemoteError(null)
    try {
      const addedRepo = await addRuntimeSshRepo(serverEnvironmentId, {
        connectionId: selectedTargetId,
        remotePath: trimmedRemotePath
      })
      const { alreadyPresent, repo } = upsertAddedRepoWithProjectHostSetup(addedRepo, {
        runtimeEnvironmentId: serverEnvironmentId
      })

      if (alreadyPresent) {
        useAppStore.getState().clearOrcaHookTrustForRepo(repo.id)
      }

      if (!mountedRef.current || gen !== remoteGenRef.current) {
        return
      }
      toast.success(
        translate('auto.components.sidebar.AddRepoSteps.df8b0e6c22', 'Project added on SSH host'),
        { description: repo.displayName }
      )
      // The repo is persisted; a non-authoritative SSH refresh must not strand the dialog.
      const ownerOptions = worktreeRefreshOptions(serverEnvironmentId)
      await fetchWorktrees(repo.id, ownerOptions)
      if (!mountedRef.current || gen !== remoteGenRef.current) {
        return
      }
      await onGitRepoReady(repo.id, ownerOptions.executionHostId)
    } catch (err) {
      const message = extractIpcErrorMessage(err, String(err))
      if (message.includes('Not a valid git repository')) {
        // Match local adds: confirm non-git feature limits before handing off to a folder workspace.
        closeModal()
        useAppStore.getState().openModal('confirm-non-git-folder', {
          folderPath: trimmedRemotePath,
          connectionId: selectedTargetId,
          runtimeEnvironmentId: serverEnvironmentId
        })
        return
      }
      if (mountedRef.current && gen === remoteGenRef.current) {
        setRemoteError(message)
      }
    } finally {
      if (mountedRef.current && gen === remoteGenRef.current) {
        setIsAddingRemote(false)
      }
    }
  }, [
    serverEnvironmentId,
    selectedTargetId,
    remotePath,
    fetchWorktrees,
    mountedRef,
    closeModal,
    onGitRepoReady
  ])

  return {
    sshTargets: displayedSshTargets,
    selectedTargetId,
    remotePath,
    remoteError,
    isAddingRemote,
    setSelectedTargetId,
    setRemotePath,
    setRemoteError,
    resetRemoteState,
    handleOpenRemoteStep,
    handleAddRemoteRepo,
    handleConnectTarget
  }
}

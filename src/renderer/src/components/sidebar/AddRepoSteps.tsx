import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { NestedRepoScanResult } from '../../../../shared/types'
import type { SshTarget, SshConnectionState } from '../../../../shared/ssh-types'
import { createNestedRepoTelemetryAttemptId } from '../../../../shared/nested-repo-telemetry'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { upsertAddedRepoWithProjectHostSetup } from './add-repo-store-upsert'

// ── SSH host project hook ───────────────────────────────────────────

export function useRemoteRepo(
  fetchWorktrees: (
    repoId: string,
    options?: { requireAuthoritative?: boolean }
  ) => Promise<unknown>,
  setStep: (step: 'add' | 'clone' | 'remote' | 'create' | 'nested') => void,
  closeModal: () => void,
  onGitRepoReady?: (repoId: string) => void | Promise<void>,
  scanNestedRepos?: (
    path: string,
    connectionId?: string,
    controls?: { scanId?: string; onProgress?: (scan: NestedRepoScanResult) => void }
  ) => Promise<NestedRepoScanResult | null>,
  showNestedRepoReview?: (
    scan: NestedRepoScanResult,
    selectedPath: string,
    connectionId: string,
    attemptId: string,
    inProgress: boolean,
    scanId: string | null
  ) => void,
  onNestedScanResult?: (scan: NestedRepoScanResult | null, attemptId: string) => void
) {
  const [sshTargets, setSshTargets] = useState<(SshTarget & { state?: SshConnectionState })[]>([])
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null)
  const [remotePath, setRemotePath] = useState('~/')
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [isAddingRemote, setIsAddingRemote] = useState(false)
  const [remoteNestedScanId, setRemoteNestedScanId] = useState<string | null>(null)
  const remoteGenRef = useRef(0)
  const mountedRef = useMountedRef()
  const cancelNestedRepoScan = useAppStore((s) => s.cancelNestedRepoScan)

  const resetRemoteState = useCallback(() => {
    remoteGenRef.current++
    setSshTargets([])
    setSelectedTargetId(null)
    setRemotePath('~/')
    setRemoteError(null)
    setIsAddingRemote(false)
    if (remoteNestedScanId) {
      void cancelNestedRepoScan(remoteNestedScanId)
    }
    setRemoteNestedScanId(null)
  }, [cancelNestedRepoScan, remoteNestedScanId])

  const stopRemoteNestedScan = useCallback(() => {
    if (!remoteNestedScanId) {
      return
    }
    void cancelNestedRepoScan(remoteNestedScanId)
  }, [cancelNestedRepoScan, remoteNestedScanId])

  const handleOpenRemoteStep = useCallback(
    async (preferredTargetId?: string | null) => {
      const gen = ++remoteGenRef.current
      setStep('remote')
      try {
        const targets = (await window.api.ssh.listTargets()) as SshTarget[]
        if (gen !== remoteGenRef.current) {
          return
        }
        const withState = await Promise.all(
          targets.map(async (t) => {
            const state = (await window.api.ssh.getState({
              targetId: t.id
            })) as SshConnectionState | null
            return { ...t, state: state ?? undefined }
          })
        )
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
      } catch {
        if (gen !== remoteGenRef.current) {
          return
        }
        setSshTargets([])
      }
    },
    [setStep]
  )

  // Why: keep the target list's connection state in sync while the dialog is
  // open, so clicking the inline Connect button below updates the dot/label
  // live without the user reopening the step.
  useEffect(() => {
    const unsubscribe = window.api.ssh.onStateChanged(({ targetId, state }) => {
      setSshTargets((prev) => prev.map((t) => (t.id === targetId ? { ...t, state } : t)))
      if (state.status === 'connected') {
        setSelectedTargetId((curr) => curr ?? targetId)
      }
    })
    return unsubscribe
  }, [])

  const handleConnectTarget = useCallback(async (targetId: string) => {
    try {
      await window.api.ssh.connect({ targetId })
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate('auto.components.sidebar.AddRepoSteps.3e64e8a70d', 'Connection failed')
      )
    }
  }, [])

  const handleAddRemoteRepo = useCallback(async () => {
    if (!selectedTargetId || !remotePath.trim()) {
      return
    }

    const trimmedRemotePath = remotePath.trim()
    const gen = ++remoteGenRef.current
    setIsAddingRemote(true)
    setRemoteError(null)
    try {
      const attemptId = createNestedRepoTelemetryAttemptId()
      const scanId = `nested-repo-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`
      setRemoteNestedScanId(scanId)
      const scan = await scanNestedRepos?.(trimmedRemotePath, selectedTargetId, {
        scanId,
        onProgress: (progressScan) => {
          if (
            gen !== remoteGenRef.current ||
            !mountedRef.current ||
            progressScan.selectedPathKind !== 'non_git_folder' ||
            progressScan.repos.length === 0
          ) {
            return
          }
          showNestedRepoReview?.(
            progressScan,
            trimmedRemotePath,
            selectedTargetId,
            attemptId,
            true,
            scanId
          )
        }
      })
      if (!mountedRef.current || gen !== remoteGenRef.current) {
        return
      }
      onNestedScanResult?.(scan ?? null, attemptId)
      if (scan?.selectedPathKind === 'non_git_folder' && scan.repos.length > 0) {
        showNestedRepoReview?.(scan, trimmedRemotePath, selectedTargetId, attemptId, false, scanId)
        setRemoteNestedScanId(null)
        return
      }
      setRemoteNestedScanId(null)
      const result = await window.api.repos.addRemote({
        connectionId: selectedTargetId,
        remotePath: trimmedRemotePath
      })
      if ('error' in result) {
        throw new Error(result.error)
      }
      const repo = result.repo

      const state = useAppStore.getState()
      const existingIdx = state.repos.findIndex((r) => r.id === repo.id)
      if (existingIdx !== -1) {
        state.clearOrcaHookTrustForRepo(repo.id)
      }
      upsertAddedRepoWithProjectHostSetup(repo)

      if (!mountedRef.current || gen !== remoteGenRef.current) {
        return
      }
      toast.success(
        translate('auto.components.sidebar.AddRepoSteps.df8b0e6c22', 'Project added on SSH host'),
        { description: repo.displayName }
      )
      // Why: the repo is already persisted here; if SSH refresh is temporarily
      // non-authoritative, finish onto the project row instead of stranding the dialog.
      await fetchWorktrees(repo.id, { requireAuthoritative: true })
      if (!mountedRef.current || gen !== remoteGenRef.current) {
        return
      }
      await onGitRepoReady?.(repo.id)
    } catch (err) {
      const message = extractIpcErrorMessage(err, String(err))
      if (message.includes('Not a valid git repository')) {
        // Why: match the local add-project flow — show confirmation dialog so
        // users understand git features will be unavailable, rather than
        // silently adding as a folder.
        closeModal()
        useAppStore.getState().openModal('confirm-non-git-folder', {
          folderPath: trimmedRemotePath,
          connectionId: selectedTargetId
        })
        return
      }
      if (mountedRef.current && gen === remoteGenRef.current) {
        setRemoteError(message)
      }
    } finally {
      if (mountedRef.current && gen === remoteGenRef.current) {
        setIsAddingRemote(false)
        setRemoteNestedScanId(null)
      }
    }
  }, [
    selectedTargetId,
    remotePath,
    scanNestedRepos,
    showNestedRepoReview,
    onNestedScanResult,
    fetchWorktrees,
    mountedRef,
    closeModal,
    onGitRepoReady
  ])

  return {
    sshTargets,
    selectedTargetId,
    remotePath,
    remoteError,
    isAddingRemote,
    isScanningNested: Boolean(remoteNestedScanId),
    setSelectedTargetId,
    setRemotePath,
    setRemoteError,
    resetRemoteState,
    handleOpenRemoteStep,
    handleAddRemoteRepo,
    handleConnectTarget,
    stopRemoteNestedScan
  }
}

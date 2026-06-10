import React, { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Folder } from 'lucide-react'
import { useAppStore } from '@/store'
import { DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useMountedRef } from '@/hooks/useMountedRef'
import { RemoteFileBrowser } from './RemoteFileBrowser'
import type { NestedRepoScanResult } from '../../../../shared/types'
import type { SshTarget, SshConnectionState } from '../../../../shared/ssh-types'
import { createNestedRepoTelemetryAttemptId } from '../../../../shared/nested-repo-telemetry'
import { translate } from '@/i18n/i18n'

// ── Remote project hook ─────────────────────────────────────────────

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

  const handleOpenRemoteStep = useCallback(async () => {
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
      const connected = withState.find((t) => t.state?.status === 'connected')
      if (connected) {
        setSelectedTargetId(connected.id)
      }
    } catch {
      if (gen !== remoteGenRef.current) {
        return
      }
      setSshTargets([])
    }
  }, [setStep])

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
      toast.error(err instanceof Error ? err.message : translate("auto.components.sidebar.AddRepoSteps.3e64e8a70d", "Connection failed"))
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
      if (existingIdx === -1) {
        useAppStore.setState({ repos: [...state.repos, repo] })
      } else {
        const updated = [...state.repos]
        updated[existingIdx] = repo
        useAppStore.setState({ repos: updated })
      }

      if (!mountedRef.current || gen !== remoteGenRef.current) {
        return
      }
      toast.success(translate("auto.components.sidebar.AddRepoSteps.df8b0e6c22", "Remote project added"), { description: repo.displayName })
      // Why: the repo is already persisted here; if SSH refresh is temporarily
      // non-authoritative, finish onto the project row instead of stranding the dialog.
      await fetchWorktrees(repo.id, { requireAuthoritative: true })
      if (!mountedRef.current || gen !== remoteGenRef.current) {
        return
      }
      await onGitRepoReady?.(repo.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
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

// ── Clone step ───────────────────────────────────────────────────────

type CloneStepProps = {
  cloneUrl: string
  cloneDestination: string
  cloneError: string | null
  cloneProgress: { phase: string; percent: number } | null
  isCloning: boolean
  disableDestinationPicker?: boolean
  runtimeEnvironmentId?: string | null
  onUrlChange: (value: string) => void
  onDestChange: (value: string) => void
  onPickDestination: () => void
  onClone: () => void
}

export function CloneStep({
  cloneUrl,
  cloneDestination,
  cloneError,
  cloneProgress,
  isCloning,
  disableDestinationPicker = false,
  runtimeEnvironmentId,
  onUrlChange,
  onDestChange,
  onPickDestination,
  onClone
}: CloneStepProps): React.JSX.Element {
  const [browsingDestination, setBrowsingDestination] = useState(false)
  const canClone = !!cloneUrl.trim() && !!cloneDestination.trim() && !isCloning
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (canClone) {
        onClone()
      }
    }
  }

  if (browsingDestination && runtimeEnvironmentId) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{translate("auto.components.sidebar.AddRepoSteps.a93ef169b5", "Browse server filesystem")}</DialogTitle>
          <DialogDescription>
            {translate("auto.components.sidebar.AddRepoSteps.fe8e629fe3", "Navigate to a directory and click Select to choose it.")}</DialogDescription>
        </DialogHeader>
        <RemoteFileBrowser
          runtimeEnvironmentId={runtimeEnvironmentId}
          initialPath={cloneDestination || '~'}
          onSelect={(path) => {
            onDestChange(path)
            setBrowsingDestination(false)
          }}
          onCancel={() => setBrowsingDestination(false)}
        />
      </>
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{translate("auto.components.sidebar.AddRepoSteps.c05f88a31f", "Clone from URL")}</DialogTitle>
        <DialogDescription>{translate("auto.components.sidebar.AddRepoSteps.5b2ea674b1", "Enter the Git URL and choose where to clone it.")}</DialogDescription>
      </DialogHeader>

      <div className="space-y-3 pt-1">
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">{translate("auto.components.sidebar.AddRepoSteps.3d4acbe693", "Git URL")}</label>
          <Input
            value={cloneUrl}
            onChange={(e) => onUrlChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={translate("auto.components.sidebar.AddRepoSteps.b698a4a29d", "https://github.com/user/repo.git")}
            className="h-8 text-xs"
            disabled={isCloning}
            autoFocus
          />
        </div>

        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">{translate("auto.components.sidebar.AddRepoSteps.04a4c4e84a", "Clone location")}</label>
          <div className="flex gap-2">
            <Input
              value={cloneDestination}
              onChange={(e) => onDestChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={translate("auto.components.sidebar.AddRepoSteps.2ce3f6edf8", "/path/to/destination")}
              className="h-8 text-xs flex-1"
              disabled={isCloning}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2 shrink-0"
              onClick={() => {
                if (runtimeEnvironmentId) {
                  setBrowsingDestination(true)
                  return
                }
                onPickDestination()
              }}
              disabled={isCloning || (disableDestinationPicker && !runtimeEnvironmentId)}
              title={runtimeEnvironmentId ? translate("auto.components.sidebar.AddRepoSteps.a93ef169b5", "Browse server filesystem") : translate("auto.components.sidebar.AddRepoSteps.569326d9cc", "Choose folder")}
              aria-label={runtimeEnvironmentId ? translate("auto.components.sidebar.AddRepoSteps.a93ef169b5", "Browse server filesystem") : translate("auto.components.sidebar.AddRepoSteps.569326d9cc", "Choose folder")}
            >
              <Folder className="size-3.5" />
            </Button>
          </div>
        </div>

        {cloneError && <p className="text-[11px] text-destructive">{cloneError}</p>}

        <Button
          onClick={onClone}
          disabled={!cloneUrl.trim() || !cloneDestination.trim() || isCloning}
          className="w-full"
        >
          {isCloning ? translate("auto.components.sidebar.AddRepoSteps.69f5b5380d", "Cloning...") : translate("auto.components.sidebar.AddRepoSteps.32a7256d85", "Clone")}
        </Button>

        {/* Why: progress bar lives below the button so it doesn't push the
           button down when it appears mid-clone. */}
        {isCloning && cloneProgress && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{cloneProgress.phase}</span>
              <span>{cloneProgress.percent}%</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
              <div
                className="h-full rounded-full bg-foreground transition-[width] duration-300 ease-out"
                style={{ width: `${cloneProgress.percent}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </>
  )
}

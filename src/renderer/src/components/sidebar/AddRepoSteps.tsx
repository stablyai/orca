/**
 * Step views for AddRepoDialog: Clone, Remote, and Setup.
 *
 * Why extracted: keeps AddRepoDialog.tsx under the 400-line oxlint limit
 * by moving the presentational JSX for each wizard step into separate components
 * while the parent retains all state and handlers.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Folder, FolderOpen, Settings } from 'lucide-react'
import { useAppStore } from '@/store'
import { DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RemoteFileBrowser } from './RemoteFileBrowser'
import { SshTargetRow } from './SshTargetRow'
import type { Repo } from '../../../../shared/types'
import type { SshTarget, SshConnectionState } from '../../../../shared/ssh-types'

// ── Remote project hook ─────────────────────────────────────────────

export function useRemoteRepo(
  fetchWorktrees: (repoId: string) => Promise<void>,
  setStep: (step: 'add' | 'clone' | 'remote' | 'setup') => void,
  setAddedRepo: (repo: Repo | null) => void,
  closeModal: () => void
) {
  const [sshTargets, setSshTargets] = useState<(SshTarget & { state?: SshConnectionState })[]>([])
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null)
  const [remotePath, setRemotePath] = useState('~/')
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [isAddingRemote, setIsAddingRemote] = useState(false)
  const remoteGenRef = useRef(0)

  const resetRemoteState = useCallback(() => {
    remoteGenRef.current++
    setSshTargets([])
    setSelectedTargetId(null)
    setRemotePath('~/')
    setRemoteError(null)
    setIsAddingRemote(false)
  }, [])

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
      toast.error(err instanceof Error ? err.message : 'Connection failed')
    }
  }, [])

  const handleAddRemoteRepo = useCallback(async () => {
    if (!selectedTargetId || !remotePath.trim()) {
      return
    }

    setIsAddingRemote(true)
    setRemoteError(null)
    try {
      const result = await window.api.repos.addRemote({
        connectionId: selectedTargetId,
        remotePath: remotePath.trim()
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

      toast.success('Remote project added', { description: repo.displayName })
      setAddedRepo(repo)
      await fetchWorktrees(repo.id)
      setStep('setup')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('Not a valid git repository')) {
        // Why: match the local add-project flow — show confirmation dialog so
        // users understand git features will be unavailable, rather than
        // silently adding as a folder.
        closeModal()
        useAppStore.getState().openModal('confirm-non-git-folder', {
          folderPath: remotePath.trim(),
          connectionId: selectedTargetId
        })
        return
      }
      setRemoteError(message)
    } finally {
      setIsAddingRemote(false)
    }
  }, [selectedTargetId, remotePath, fetchWorktrees, setStep, setAddedRepo, closeModal])

  return {
    sshTargets,
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

// ── Remote step ──────────────────────────────────────────────────────

type RemoteStepProps = {
  sshTargets: (SshTarget & { state?: SshConnectionState })[]
  selectedTargetId: string | null
  remotePath: string
  remoteError: string | null
  isAddingRemote: boolean
  onSelectTarget: (id: string) => void
  onRemotePathChange: (value: string) => void
  onAdd: () => void
  onOpenSshSettings: () => void
  onConnectTarget: (id: string) => Promise<void>
}

export function RemoteStep({
  sshTargets,
  selectedTargetId,
  remotePath,
  remoteError,
  isAddingRemote,
  onSelectTarget,
  onRemotePathChange,
  onAdd,
  onOpenSshSettings,
  onConnectTarget
}: RemoteStepProps): React.JSX.Element {
  const [browsing, setBrowsing] = useState(false)

  if (browsing && selectedTargetId) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Browse remote filesystem</DialogTitle>
          <DialogDescription>
            Navigate to a directory and click Select to choose it.
          </DialogDescription>
        </DialogHeader>
        <RemoteFileBrowser
          targetId={selectedTargetId}
          initialPath={remotePath || '~'}
          onSelect={(path) => {
            onRemotePathChange(path)
            setBrowsing(false)
          }}
          onCancel={() => setBrowsing(false)}
        />
      </>
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Open remote project</DialogTitle>
        <DialogDescription>
          Choose a connected SSH target and enter the path to a Git repository.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 pt-1">
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">SSH target</label>
          {sshTargets.length === 0 ? (
            <div className="space-y-1.5 py-1">
              <p className="text-xs text-muted-foreground">No SSH targets configured.</p>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={onOpenSshSettings}
              >
                <Settings className="size-3.5" />
                Add in Settings
              </Button>
            </div>
          ) : (
            <div className="space-y-1.5">
              {sshTargets.map((target) => (
                <SshTargetRow
                  key={target.id}
                  target={target}
                  isSelected={selectedTargetId === target.id}
                  onSelect={onSelectTarget}
                  onConnect={onConnectTarget}
                />
              ))}
            </div>
          )}
        </div>

        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">Remote path</label>
          <div className="flex gap-2">
            <Input
              value={remotePath}
              onChange={(e) => onRemotePathChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  if (selectedTargetId && remotePath.trim() && !isAddingRemote) {
                    onAdd()
                  }
                }
              }}
              placeholder="/home/user/project"
              className="h-8 text-xs flex-1"
              disabled={isAddingRemote || !selectedTargetId}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2 shrink-0"
              onClick={() => setBrowsing(true)}
              disabled={!selectedTargetId || isAddingRemote}
            >
              <FolderOpen className="size-3.5" />
            </Button>
          </div>
        </div>

        {remoteError && <p className="text-[11px] text-destructive">{remoteError}</p>}

        <Button
          onClick={onAdd}
          disabled={!selectedTargetId || !remotePath.trim() || isAddingRemote}
          className="w-full"
        >
          {isAddingRemote ? 'Adding...' : 'Add remote project'}
        </Button>
      </div>
    </>
  )
}

// ── Clone step ───────────────────────────────────────────────────────

type CloneStepProps = {
  cloneUrl: string
  cloneDestination: string
  cloneError: string | null
  cloneProgress: { phase: string; percent: number } | null
  isCloning: boolean
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
  onUrlChange,
  onDestChange,
  onPickDestination,
  onClone
}: CloneStepProps): React.JSX.Element {
  const canClone = !!cloneUrl.trim() && !!cloneDestination.trim() && !isCloning
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (canClone) {
        onClone()
      }
    }
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>Clone from URL</DialogTitle>
        <DialogDescription>Enter the Git URL and choose where to clone it.</DialogDescription>
      </DialogHeader>

      <div className="space-y-3 pt-1">
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">Git URL</label>
          <Input
            value={cloneUrl}
            onChange={(e) => onUrlChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="https://github.com/user/repo.git"
            className="h-8 text-xs"
            disabled={isCloning}
            autoFocus
          />
        </div>

        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">Clone location</label>
          <div className="flex gap-2">
            <Input
              value={cloneDestination}
              onChange={(e) => onDestChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="/path/to/destination"
              className="h-8 text-xs flex-1"
              disabled={isCloning}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2 shrink-0"
              onClick={onPickDestination}
              disabled={isCloning}
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
          {isCloning ? 'Cloning...' : 'Clone'}
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

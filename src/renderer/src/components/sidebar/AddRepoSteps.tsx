/* eslint-disable max-lines -- Why: step-specific hooks and views are intentionally colocated so add-repo wizard behavior stays synchronized across flows. */
/**
 * Step views and flow hooks for AddRepoDialog.
 *
 * Why extracted: presentational JSX and per-step behavior live together so
 * AddRepoDialog can focus on top-level orchestration and modal transitions.
 */
import React, { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Folder, FolderOpen, FolderPlus, GitBranch, GitBranchPlus, Settings } from 'lucide-react'
import { useAppStore } from '@/store'
import { DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RemoteFileBrowser } from './RemoteFileBrowser'
import { LinkedWorktreeItem } from './LinkedWorktreeItem'
import type { Repo, Worktree } from '../../../../shared/types'
import type { SshTarget, SshConnectionState } from '../../../../shared/ssh-types'

// ── Remote repo hook ────────────────────────────────────────────────

export function useRemoteRepo(
  fetchWorktrees: (repoId: string) => Promise<void>,
  setStep: (step: 'add' | 'clone' | 'remote' | 'create' | 'setup') => void,
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
      if (existingIdx === -1) {
        useAppStore.setState({ repos: [...state.repos, repo] })
      } else {
        const updated = [...state.repos]
        updated[existingIdx] = repo
        useAppStore.setState({ repos: updated })
      }

      toast.success('Remote repository added', { description: repo.displayName })
      setAddedRepo(repo)
      await fetchWorktrees(repo.id)
      setStep('setup')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('Not a valid git repository')) {
        // Why: match the local add-repo flow — show confirmation dialog so
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
    handleAddRemoteRepo
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
}

export function RemoteStep({
  sshTargets,
  selectedTargetId,
  remotePath,
  remoteError,
  isAddingRemote,
  onSelectTarget,
  onRemotePathChange,
  onAdd
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
        <DialogTitle>Open remote repo</DialogTitle>
        <DialogDescription>
          Choose a connected SSH target and enter the path to a Git repository.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 pt-1">
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">SSH target</label>
          {sshTargets.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">
              No SSH targets configured. Add one in Settings first.
            </p>
          ) : (
            <div className="space-y-1.5">
              {sshTargets.map((target) => {
                const isConnected = target.state?.status === 'connected'
                const isSelected = selectedTargetId === target.id
                return (
                  <button
                    key={target.id}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-md border text-xs transition-colors cursor-pointer ${
                      isSelected
                        ? 'border-foreground/30 bg-accent'
                        : 'border-border hover:bg-accent/50'
                    } ${!isConnected ? 'opacity-50' : ''}`}
                    onClick={() => {
                      if (isConnected) {
                        onSelectTarget(target.id)
                      }
                    }}
                    disabled={!isConnected}
                  >
                    <span
                      className={`size-2 rounded-full shrink-0 ${isConnected ? 'bg-green-500' : 'bg-muted-foreground/30'}`}
                    />
                    <span className="font-medium truncate">
                      {target.label || `${target.username}@${target.host}`}
                    </span>
                    {!isConnected && (
                      <span className="text-muted-foreground ml-auto">Not connected</span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">Remote path</label>
          <div className="flex gap-2">
            <Input
              value={remotePath}
              onChange={(e) => onRemotePathChange(e.target.value)}
              placeholder="/home/user/project"
              className="h-8 text-xs flex-1"
              disabled={isAddingRemote}
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
          {isAddingRemote ? 'Adding...' : 'Add remote repo'}
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

// ── Create-local step ───────────────────────────────────────────────

type CreateLocalStepProps = {
  name: string
  parentPath: string
  kind: 'git' | 'folder'
  isCreating: boolean
  error: string | null
  onNameChange: (value: string) => void
  onParentPathChange: (value: string) => void
  onKindChange: (value: 'git' | 'folder') => void
  onPickParentPath: () => void
  onCreate: () => void
}

export function CreateLocalStep({
  name,
  parentPath,
  kind,
  isCreating,
  error,
  onNameChange,
  onParentPathChange,
  onKindChange,
  onPickParentPath,
  onCreate
}: CreateLocalStepProps): React.JSX.Element {
  const createLabel = kind === 'git' ? 'Create repository' : 'Create folder'
  return (
    <>
      <DialogHeader>
        <DialogTitle>Create new repo or folder</DialogTitle>
        <DialogDescription>
          Choose a location, enter a name, and decide whether to initialize Git.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 pt-1">
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">Type</label>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant={kind === 'git' ? 'default' : 'outline'}
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => onKindChange('git')}
              disabled={isCreating}
            >
              <GitBranch className="size-3.5" />
              Git repo
            </Button>
            <Button
              variant={kind === 'folder' ? 'default' : 'outline'}
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => onKindChange('folder')}
              disabled={isCreating}
            >
              <FolderPlus className="size-3.5" />
              Folder only
            </Button>
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">Name</label>
          <Input
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="my-project"
            className="h-8 text-xs"
            disabled={isCreating}
            autoFocus
          />
        </div>

        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">Location</label>
          <div className="flex gap-2">
            <Input
              value={parentPath}
              onChange={(e) => onParentPathChange(e.target.value)}
              placeholder="/path/to/parent-folder"
              className="h-8 text-xs flex-1"
              disabled={isCreating}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2 shrink-0"
              onClick={onPickParentPath}
              disabled={isCreating}
            >
              <Folder className="size-3.5" />
            </Button>
          </div>
        </div>

        {error && <p className="text-[11px] text-destructive">{error}</p>}

        <Button
          onClick={onCreate}
          disabled={!name.trim() || !parentPath.trim() || isCreating}
          className="w-full"
        >
          {isCreating ? 'Creating...' : createLabel}
        </Button>
      </div>
    </>
  )
}

// ── Setup step ──────────────────────────────────────────────────────

type SetupStepProps = {
  addedRepo: Repo | null
  sortedWorktrees: Worktree[]
  hasWorktrees: boolean
  onOpenWorktree: (worktree: Worktree) => void
  onCreateWorktree: () => void
  onConfigureRepo: () => void
  onSkip: () => void
}

export function SetupStep({
  addedRepo,
  sortedWorktrees,
  hasWorktrees,
  onOpenWorktree,
  onCreateWorktree,
  onConfigureRepo,
  onSkip
}: SetupStepProps): React.JSX.Element {
  const worktreesCount = sortedWorktrees.length
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {hasWorktrees ? 'Open or create a worktree' : 'Set up your first worktree'}
        </DialogTitle>
        <DialogDescription>
          {hasWorktrees
            ? `${addedRepo?.displayName} has ${worktreesCount} worktree${worktreesCount !== 1 ? 's' : ''}. Open one to pick up where you left off, or create a new one.`
            : `Orca uses git worktrees as isolated task environments. Create one for ${addedRepo?.displayName} to get started.`}
        </DialogDescription>
      </DialogHeader>

      {hasWorktrees && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Existing worktrees
          </p>
          <div className="space-y-1.5 max-h-[40vh] overflow-y-auto scrollbar-sleek pr-1">
            {sortedWorktrees.map((worktree) => (
              <LinkedWorktreeItem
                key={worktree.id}
                worktree={worktree}
                onOpen={() => onOpenWorktree(worktree)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3 pt-2">
        <Button onClick={onCreateWorktree} className="w-full">
          <GitBranchPlus className="size-4 mr-2" />
          {hasWorktrees ? 'Create new worktree' : 'Create first worktree'}
        </Button>

        <div className="flex items-center justify-between">
          <button
            className="inline-flex items-center justify-center gap-1.5 text-xs text-muted-foreground/70 hover:text-foreground transition-colors cursor-pointer"
            onClick={onConfigureRepo}
          >
            <Settings className="size-3" />
            Configure repo
          </button>
          <Button variant="ghost" size="sm" className="text-xs" onClick={onSkip}>
            Skip
          </Button>
        </div>
      </div>
    </>
  )
}

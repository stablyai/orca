/* eslint-disable max-lines -- Why: AddRepoDialog owns a multi-step flow (add/clone/setup) with
   clone progress, abort handling, and worktree setup — splitting further would scatter
   tightly coupled step transitions across files. */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { FolderOpen, GitBranchPlus, Settings, ArrowLeft, Globe, Folder } from 'lucide-react'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { LinkedWorktreeItem } from './LinkedWorktreeItem'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { Repo, Worktree } from '../../../../shared/types'

const AddRepoDialog = React.memo(function AddRepoDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const closeModal = useAppStore((s) => s.closeModal)
  const addRepo = useAppStore((s) => s.addRepo)
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const openModal = useAppStore((s) => s.openModal)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)

  const [step, setStep] = useState<'add' | 'clone' | 'setup'>('add')
  const [addedRepo, setAddedRepo] = useState<Repo | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [cloneUrl, setCloneUrl] = useState('')
  const [cloneDestination, setCloneDestination] = useState('')
  const [isCloning, setIsCloning] = useState(false)
  const [cloneError, setCloneError] = useState<string | null>(null)
  const [cloneProgress, setCloneProgress] = useState<{ phase: string; percent: number } | null>(
    null
  )
  // Why: track a monotonically increasing ID so that when the user closes the
  // dialog or navigates away during a clone, the stale completion callback can
  // detect it was superseded and bail out instead of corrupting dialog state.
  const cloneGenRef = useRef(0)

  // Subscribe to clone progress events while cloning is active
  useEffect(() => {
    if (!isCloning) {
      return
    }
    return window.api.repos.onCloneProgress(setCloneProgress)
  }, [isCloning])

  const isOpen = activeModal === 'add-repo'
  const repoId = addedRepo?.id ?? ''

  const worktrees = useMemo(() => {
    return worktreesByRepo[repoId] ?? []
  }, [worktreesByRepo, repoId])

  // Why: sort by recent activity (lastActivityAt) with alphabetical fallback for
  // worktrees not yet opened in Orca. Matches buildWorktreeComparator behavior.
  const sortedWorktrees = useMemo(() => {
    return [...worktrees].sort((a, b) => {
      if (a.lastActivityAt !== b.lastActivityAt) {
        return b.lastActivityAt - a.lastActivityAt
      }
      return a.displayName.localeCompare(b.displayName)
    })
  }, [worktrees])

  const hasWorktrees = worktrees.length > 0

  const resetState = useCallback(() => {
    cloneGenRef.current++
    // Why: kill the git clone process if one is running, so backing out
    // or closing the dialog doesn't leave a clone running on disk.
    void window.api.repos.cloneAbort()
    setStep('add')
    setAddedRepo(null)
    setIsAdding(false)
    setCloneUrl('')
    setCloneDestination('')
    setIsCloning(false)
    setCloneError(null)
    setCloneProgress(null)
  }, [])

  // Why: reset all local state when the dialog closes for any reason —
  // whether via onOpenChange, closeModal() from code, or activeModal
  // being replaced by another modal. Without this, reopening the dialog
  // can show a stale step/repo from the previous session.
  useEffect(() => {
    if (!isOpen) {
      resetState()
    }
  }, [isOpen, resetState])

  const isInputStep = step === 'add' || step === 'clone'

  const handleBrowse = useCallback(async () => {
    setIsAdding(true)
    try {
      const repo = await addRepo()
      if (repo && isGitRepoKind(repo)) {
        setAddedRepo(repo)
        await fetchWorktrees(repo.id)
        setStep('setup')
      } else if (repo) {
        // Why: non-git folders have no worktrees, so step 2 is irrelevant. Close
        // the modal after the folder is added.
        closeModal()
      }
      // null = user cancelled the picker, or the non-git-folder confirmation
      // dialog took over (which replaces activeModal, closing this dialog).
    } finally {
      setIsAdding(false)
    }
  }, [addRepo, fetchWorktrees, closeModal])

  const handlePickDestination = useCallback(async () => {
    const dir = await window.api.repos.pickDirectory()
    if (dir) {
      setCloneDestination(dir)
      setCloneError(null)
    }
  }, [])

  const handleClone = useCallback(async () => {
    const trimmedUrl = cloneUrl.trim()
    if (!trimmedUrl || !cloneDestination.trim()) {
      return
    }
    const gen = ++cloneGenRef.current
    setIsCloning(true)
    setCloneError(null)
    setCloneProgress(null)
    try {
      const repo = (await window.api.repos.clone({
        url: trimmedUrl,
        destination: cloneDestination.trim()
      })) as Repo
      // Why: if the user closed the dialog or clicked Back during the clone,
      // cloneGenRef will have been bumped by resetState. Ignore this stale result.
      if (gen !== cloneGenRef.current) {
        return
      }
      toast.success('Repository cloned', { description: repo.displayName })
      // Why: eagerly upsert the cloned repo in the store so that step 2's
      // "Create worktree" button finds it in eligibleRepos immediately,
      // without waiting for the async repos:changed IPC event. This also
      // handles the case where a folder repo was upgraded to git by the
      // clone handler — the existing entry needs its kind updated.
      const state = useAppStore.getState()
      const existingIdx = state.repos.findIndex((r) => r.id === repo.id)
      if (existingIdx === -1) {
        useAppStore.setState({ repos: [...state.repos, repo] })
      } else {
        const updated = [...state.repos]
        updated[existingIdx] = repo
        useAppStore.setState({ repos: updated })
      }
      setAddedRepo(repo)
      await fetchWorktrees(repo.id)
      setStep('setup')
    } catch (err) {
      if (gen !== cloneGenRef.current) {
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      setCloneError(message)
    } finally {
      if (gen === cloneGenRef.current) {
        setIsCloning(false)
      }
    }
  }, [cloneUrl, cloneDestination, fetchWorktrees])

  const handleOpenWorktree = useCallback(
    (worktree: Worktree) => {
      activateAndRevealWorktree(worktree.id)
      closeModal()
    },
    [closeModal]
  )

  const handleCreateWorktree = useCallback(() => {
    closeModal()
    // Why: small delay so the close animation finishes before the create dialog opens.
    setTimeout(() => {
      openModal('create-worktree', { preselectedRepoId: repoId })
    }, 150)
  }, [closeModal, openModal, repoId])

  const handleConfigureRepo = useCallback(() => {
    closeModal()
    openSettingsTarget({ pane: 'repo', repoId })
    setActiveView('settings')
  }, [closeModal, openSettingsTarget, setActiveView, repoId])

  const handleBack = useCallback(() => {
    cloneGenRef.current++
    void window.api.repos.cloneAbort()
    setStep('add')
    setAddedRepo(null)
    setCloneUrl('')
    setCloneDestination('')
    setIsCloning(false)
    setCloneError(null)
    setCloneProgress(null)
  }, [])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal()
        resetState()
      }
    },
    [closeModal, resetState]
  )

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* Step indicator row — back button (step 2 only), dots, X is rendered by DialogContent */}
        <div className="flex items-center justify-center -mt-1">
          {step === 'clone' && (
            <button
              className="absolute left-6 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              onClick={handleBack}
            >
              <ArrowLeft className="size-3" />
              Back
            </button>
          )}
          {step === 'setup' && (
            <button
              className="absolute left-6 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              onClick={handleBack}
            >
              <ArrowLeft className="size-3" />
              Add another repo
            </button>
          )}
          <div className="flex items-center gap-1.5">
            <div
              className={`size-1.5 rounded-full transition-colors ${isInputStep ? 'bg-foreground' : 'bg-muted-foreground/30'}`}
            />
            <div
              className={`size-1.5 rounded-full transition-colors ${step === 'setup' ? 'bg-foreground' : 'bg-muted-foreground/30'}`}
            />
          </div>
        </div>

        {step === 'add' ? (
          <>
            <DialogHeader>
              <DialogTitle>Add a repository</DialogTitle>
              <DialogDescription>
                {repos.length === 0
                  ? 'Add a repository to get started with Orca.'
                  : 'Add another repository to manage with Orca.'}
              </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-2 gap-3 pt-2">
              <Button
                onClick={handleBrowse}
                disabled={isAdding}
                variant="outline"
                className="h-auto py-4 px-4 flex flex-col items-center gap-2 text-center"
              >
                <FolderOpen className="size-6 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Browse folder</p>
                  <p className="text-xs text-muted-foreground font-normal mt-0.5">
                    Local repository or folder
                  </p>
                </div>
              </Button>

              <Button
                onClick={() => setStep('clone')}
                variant="outline"
                className="h-auto py-4 px-4 flex flex-col items-center gap-2 text-center"
              >
                <Globe className="size-6 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Clone from URL</p>
                  <p className="text-xs text-muted-foreground font-normal mt-0.5">
                    Remote Git repository
                  </p>
                </div>
              </Button>
            </div>
          </>
        ) : step === 'clone' ? (
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
                  onChange={(e) => {
                    setCloneUrl(e.target.value)
                    setCloneError(null)
                  }}
                  placeholder="https://github.com/user/repo.git"
                  className="h-8 text-xs"
                  disabled={isCloning}
                  autoFocus
                />
              </div>

              <div className="space-y-1">
                <label className="text-[11px] font-medium text-muted-foreground">
                  Clone location
                </label>
                <div className="flex gap-2">
                  <Input
                    value={cloneDestination}
                    onChange={(e) => {
                      setCloneDestination(e.target.value)
                      setCloneError(null)
                    }}
                    placeholder="/path/to/destination"
                    className="h-8 text-xs flex-1"
                    disabled={isCloning}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 px-2 shrink-0"
                    onClick={handlePickDestination}
                    disabled={isCloning}
                  >
                    <Folder className="size-3.5" />
                  </Button>
                </div>
              </div>

              {cloneError && <p className="text-[11px] text-destructive">{cloneError}</p>}

              <Button
                onClick={handleClone}
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
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {hasWorktrees ? 'Open or create a worktree' : 'Set up your first worktree'}
              </DialogTitle>
              <DialogDescription>
                {hasWorktrees
                  ? `${addedRepo?.displayName} has ${worktrees.length} worktree${worktrees.length !== 1 ? 's' : ''}. Open one to pick up where you left off, or create a new one.`
                  : `Orca uses git worktrees as isolated task environments. Create one for ${addedRepo?.displayName} to get started.`}
              </DialogDescription>
            </DialogHeader>

            {hasWorktrees && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Existing worktrees
                </p>
                <div className="space-y-1.5 max-h-[40vh] overflow-y-auto scrollbar-sleek pr-1">
                  {sortedWorktrees.map((wt) => (
                    <LinkedWorktreeItem
                      key={wt.id}
                      worktree={wt}
                      onOpen={() => handleOpenWorktree(wt)}
                    />
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-3 pt-2">
              <Button onClick={handleCreateWorktree} className="w-full">
                <GitBranchPlus className="size-4 mr-2" />
                {hasWorktrees ? 'Create new worktree' : 'Create first worktree'}
              </Button>

              <div className="flex items-center justify-between">
                <button
                  className="inline-flex items-center justify-center gap-1.5 text-xs text-muted-foreground/70 hover:text-foreground transition-colors cursor-pointer"
                  onClick={handleConfigureRepo}
                >
                  <Settings className="size-3" />
                  Configure repo
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                  onClick={() => handleOpenChange(false)}
                >
                  Skip
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
})

export default AddRepoDialog

import React, { useCallback, useEffect, useMemo, useState } from 'react'
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
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-activation'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { Repo, Worktree } from '../../../../shared/types'

function LinkedWorktreeItem({
  worktree,
  onOpen
}: {
  worktree: Worktree
  onOpen: () => void
}): React.JSX.Element {
  const branchLabel = worktree.branch.replace(/^refs\/heads\//, '')

  return (
    <button
      className="group flex items-center justify-between gap-3 w-full rounded-md border border-border/60 bg-secondary/30 px-3 py-2 text-left transition-colors hover:bg-accent cursor-pointer"
      onClick={onOpen}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{worktree.displayName}</p>
        {branchLabel !== worktree.displayName && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">{branchLabel}</p>
        )}
      </div>
      <span className="shrink-0 text-xs font-medium text-muted-foreground group-hover:text-foreground transition-colors">
        Open
      </span>
    </button>
  )
}

const AddRepoDialog = React.memo(function AddRepoDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const closeModal = useAppStore((s) => s.closeModal)
  const addRepo = useAppStore((s) => s.addRepo)
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setActiveRepo = useAppStore((s) => s.setActiveRepo)
  const revealWorktreeInSidebar = useAppStore((s) => s.revealWorktreeInSidebar)
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
    setStep('add')
    setAddedRepo(null)
    setIsAdding(false)
    setCloneUrl('')
    setCloneDestination('')
    setIsCloning(false)
    setCloneError(null)
    setCloneProgress(null)
  }, [])

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
    setIsCloning(true)
    setCloneError(null)
    setCloneProgress(null)
    try {
      const repo = (await window.api.repos.clone({
        url: trimmedUrl,
        destination: cloneDestination.trim()
      })) as Repo
      toast.success('Repository cloned', { description: repo.displayName })
      setAddedRepo(repo)
      await fetchWorktrees(repo.id)
      setStep('setup')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setCloneError(message)
    } finally {
      setIsCloning(false)
    }
  }, [cloneUrl, cloneDestination, fetchWorktrees])

  const handleOpenWorktree = useCallback(
    (worktree: Worktree) => {
      setActiveRepo(repoId)
      setActiveWorktree(worktree.id)
      // Why: opening an existing worktree from onboarding should create an initial
      // terminal tab using the same activation path as post-create. This is a
      // visibility/activation improvement — no git worktree add, no disk changes.
      ensureWorktreeHasInitialTerminal(useAppStore.getState(), worktree.id)
      revealWorktreeInSidebar(worktree.id)
      closeModal()
    },
    [repoId, setActiveRepo, setActiveWorktree, revealWorktreeInSidebar, closeModal]
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
    setStep('add')
    setAddedRepo(null)
    setCloneUrl('')
    setCloneDestination('')
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
              onClick={() => setStep('add')}
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

              <Button
                onClick={handleClone}
                disabled={!cloneUrl.trim() || !cloneDestination.trim() || isCloning}
                className="w-full"
              >
                {isCloning ? 'Cloning...' : 'Clone'}
              </Button>
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

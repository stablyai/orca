import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { FolderOpen, GitBranchPlus, Settings, ArrowLeft, Globe, Monitor } from 'lucide-react'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { LinkedWorktreeItem } from './LinkedWorktreeItem'
import { RemoteStep, CloneStep, useRemoteRepo } from './AddRepoSteps'
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
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)

  const [step, setStep] = useState<'add' | 'clone' | 'remote' | 'setup'>('add')
  const [addedRepo, setAddedRepo] = useState<Repo | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [cloneUrl, setCloneUrl] = useState('')
  const [cloneDestination, setCloneDestination] = useState('')
  const [isCloning, setIsCloning] = useState(false)
  const [cloneError, setCloneError] = useState<string | null>(null)
  const [cloneProgress, setCloneProgress] = useState<{ phase: string; percent: number } | null>(
    null
  )

  // Why: monotonic ID so stale clone callbacks can detect they were superseded.
  const cloneGenRef = useRef(0)

  const {
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
  } = useRemoteRepo(fetchWorktrees, setStep, setAddedRepo, closeModal)
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

  // Why: sort by recent activity with alphabetical fallback.
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
    resetRemoteState()
  }, [resetRemoteState])

  // Why: reset state on close so reopening doesn't show stale step/repo.
  useEffect(() => {
    if (!isOpen) {
      resetState()
    }
  }, [isOpen, resetState])

  const isInputStep = step === 'add' || step === 'clone' || step === 'remote'

  const handleBrowse = useCallback(async () => {
    setIsAdding(true)
    try {
      const repo = await addRepo()
      if (repo && isGitRepoKind(repo)) {
        setAddedRepo(repo)
        await fetchWorktrees(repo.id)
        setStep('setup')
      } else if (repo) {
        // Why: non-git folders have no worktrees — close immediately.
        closeModal()
      }
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
      // Why: eagerly upsert so step 2 finds the repo before the IPC event.
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
    // Why: small delay so the Add Project dialog close animation finishes before
    // the composer modal takes focus; otherwise the dialog teardown can steal
    // the first focus frame from the composer's prompt textarea.
    closeModal()
    setTimeout(() => {
      openModal('new-workspace-composer', { initialRepoId: repoId })
    }, 150)
  }, [closeModal, openModal, repoId])

  const handleConfigureRepo = useCallback(() => {
    closeModal()
    openSettingsTarget({ pane: 'repo', repoId })
    openSettingsPage()
  }, [closeModal, openSettingsTarget, openSettingsPage, repoId])

  // Why: handleBack reuses resetState which already aborts clones and resets all fields.
  const handleBack = resetState

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          closeModal()
          resetState()
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        {/* Step indicator row — back button (step 2 only), dots, X is rendered by DialogContent */}
        <div className="flex items-center justify-center -mt-1">
          {(step === 'clone' || step === 'remote') && (
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
              Add another project
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
              <DialogTitle>Add a project</DialogTitle>
              <DialogDescription>
                {repos.length === 0
                  ? 'Add a project to get started with Orca.'
                  : 'Add another project to manage with Orca.'}
              </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-3 gap-3 pt-2">
              <Button
                onClick={handleBrowse}
                disabled={isAdding}
                variant="outline"
                className="h-auto py-5 px-2 flex flex-col items-center gap-2 text-center"
              >
                <FolderOpen className="size-6 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Browse folder</p>
                  <p className="text-[11px] text-muted-foreground font-normal mt-0.5">
                    Local Git project or folder
                  </p>
                </div>
              </Button>

              <Button
                onClick={() => setStep('clone')}
                variant="outline"
                className="h-auto py-5 px-2 flex flex-col items-center gap-2 text-center"
              >
                <Globe className="size-6 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Clone from URL</p>
                  <p className="text-[11px] text-muted-foreground font-normal mt-0.5">
                    Remote Git repository
                  </p>
                </div>
              </Button>

              <Button
                onClick={handleOpenRemoteStep}
                variant="outline"
                className="h-auto py-5 px-2 flex flex-col items-center gap-2 text-center"
              >
                <Monitor className="size-6 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Remote project</p>
                  <p className="text-[11px] text-muted-foreground font-normal mt-0.5">
                    SSH connected target
                  </p>
                </div>
              </Button>
            </div>
          </>
        ) : step === 'remote' ? (
          <RemoteStep
            sshTargets={sshTargets}
            selectedTargetId={selectedTargetId}
            remotePath={remotePath}
            remoteError={remoteError}
            isAddingRemote={isAddingRemote}
            onSelectTarget={(id) => {
              setSelectedTargetId(id)
              setRemoteError(null)
            }}
            onRemotePathChange={(value) => {
              setRemotePath(value)
              setRemoteError(null)
            }}
            onAdd={handleAddRemoteRepo}
          />
        ) : step === 'clone' ? (
          <CloneStep
            cloneUrl={cloneUrl}
            cloneDestination={cloneDestination}
            cloneError={cloneError}
            cloneProgress={cloneProgress}
            isCloning={isCloning}
            onUrlChange={(value) => {
              setCloneUrl(value)
              setCloneError(null)
            }}
            onDestChange={(value) => {
              setCloneDestination(value)
              setCloneError(null)
            }}
            onPickDestination={handlePickDestination}
            onClone={handleClone}
          />
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
                  Configure project
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                  onClick={() => {
                    closeModal()
                    resetState()
                  }}
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

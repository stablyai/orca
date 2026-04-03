import React, { useState, useCallback, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'
import RepoDotLabel from '@/components/repo/RepoDotLabel'
import { parseGitHubIssueOrPRNumber } from '@/lib/github-links'
import { SPACE_NAMES } from '@/constants/space-names'

const DIALOG_CLOSE_RESET_DELAY_MS = 200

const AddWorktreeDialog = React.memo(function AddWorktreeDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const repos = useAppStore((s) => s.repos)
  const createWorktree = useAppStore((s) => s.createWorktree)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const setActiveRepo = useAppStore((s) => s.setActiveRepo)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const searchQuery = useAppStore((s) => s.searchQuery)
  const setSearchQuery = useAppStore((s) => s.setSearchQuery)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const setFilterRepoIds = useAppStore((s) => s.setFilterRepoIds)
  const revealWorktreeInSidebar = useAppStore((s) => s.revealWorktreeInSidebar)
  const setRightSidebarOpen = useAppStore((s) => s.setRightSidebarOpen)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const settings = useAppStore((s) => s.settings)

  const [repoId, setRepoId] = useState<string>('')
  const [name, setName] = useState('')
  const [linkedIssue, setLinkedIssue] = useState('')
  const [comment, setComment] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const lastSuggestedNameRef = useRef('')
  const resetTimeoutRef = useRef<number | null>(null)
  const prevIsOpenRef = useRef(false)
  const prevSuggestedNameRef = useRef('')

  const isOpen = activeModal === 'create-worktree'
  const preselectedRepoId =
    typeof modalData.preselectedRepoId === 'string' ? modalData.preselectedRepoId : ''
  const activeWorktreeRepoId = useMemo(
    () => findRepoIdForWorktree(activeWorktreeId, worktreesByRepo),
    [activeWorktreeId, worktreesByRepo]
  )
  const selectedRepo = repos.find((r) => r.id === repoId)
  const suggestedName = useMemo(
    () => getSuggestedSpaceName(repoId, worktreesByRepo, settings?.nestWorkspaces ?? false),
    [repoId, worktreesByRepo, settings?.nestWorkspaces]
  )

  // Auto-select repo when dialog opens (adjusting state during render)
  if (isOpen && !prevIsOpenRef.current && repos.length > 0) {
    if (preselectedRepoId && repos.some((repo) => repo.id === preselectedRepoId)) {
      setRepoId(preselectedRepoId)
    } else if (activeWorktreeRepoId && repos.some((repo) => repo.id === activeWorktreeRepoId)) {
      setRepoId(activeWorktreeRepoId)
    } else if (activeRepoId && repos.some((repo) => repo.id === activeRepoId)) {
      setRepoId(activeRepoId)
    } else {
      setRepoId(repos[0].id)
    }
  }
  prevIsOpenRef.current = isOpen

  // Auto-fill name from suggestion (adjusting state during render)
  if (isOpen && repoId && suggestedName && suggestedName !== prevSuggestedNameRef.current) {
    const shouldApplySuggestion = !name.trim() || name === lastSuggestedNameRef.current
    prevSuggestedNameRef.current = suggestedName
    if (shouldApplySuggestion) {
      setName(suggestedName)
      lastSuggestedNameRef.current = suggestedName
    }
  }
  if (!isOpen) {
    prevSuggestedNameRef.current = ''
  }

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal()
      }
    },
    [closeModal]
  )

  const handleCreate = useCallback(async () => {
    if (!repoId || !name.trim()) {
      return
    }
    setCreateError(null)
    setCreating(true)
    try {
      const wt = await createWorktree(repoId, name.trim())
      // Meta update is best-effort — the worktree already exists, so don't
      // block the success path if only the metadata write fails.
      try {
        const metaUpdates: Record<string, unknown> = {}
        if (linkedIssue.trim()) {
          const linkedIssueNumber = parseGitHubIssueOrPRNumber(linkedIssue)
          if (linkedIssueNumber !== null) {
            ;(metaUpdates as { linkedIssue: number }).linkedIssue = linkedIssueNumber
          }
        }
        if (comment.trim()) {
          ;(metaUpdates as { comment: string }).comment = comment.trim()
        }
        if (Object.keys(metaUpdates).length > 0) {
          await updateWorktreeMeta(wt.id, metaUpdates as { linkedIssue?: number; comment?: string })
        }
      } catch {
        console.error('Failed to update worktree meta after creation')
      }

      setActiveRepo(repoId)
      setActiveView('terminal')
      setSidebarOpen(true)
      if (searchQuery) {
        setSearchQuery('')
      }
      if (filterRepoIds.length > 0 && !filterRepoIds.includes(repoId)) {
        setFilterRepoIds([])
      }
      setActiveWorktree(wt.id)
      revealWorktreeInSidebar(wt.id)
      if (settings?.rightSidebarOpenByDefault) {
        setRightSidebarTab('explorer')
        setRightSidebarOpen(true)
      }
      handleOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create worktree.'
      setCreateError(message)
      toast.error(message)
    } finally {
      setCreating(false)
    }
  }, [
    repoId,
    name,
    linkedIssue,
    comment,
    createWorktree,
    updateWorktreeMeta,
    setActiveRepo,
    setActiveView,
    setSidebarOpen,
    searchQuery,
    setSearchQuery,
    filterRepoIds,
    setFilterRepoIds,
    setActiveWorktree,
    revealWorktreeInSidebar,
    setRightSidebarOpen,
    setRightSidebarTab,
    settings?.rightSidebarOpenByDefault,
    handleOpenChange
  ])

  const handleNameChange = useCallback(
    (value: string) => {
      setName(value)
      if (createError) {
        setCreateError(null)
      }
    },
    [createError]
  )

  const handleRepoChange = useCallback(
    (value: string) => {
      setRepoId(value)
      if (createError) {
        setCreateError(null)
      }
    },
    [createError]
  )

  // Auto-select repo when opening.
  React.useEffect(() => {
    if (resetTimeoutRef.current !== null) {
      window.clearTimeout(resetTimeoutRef.current)
      resetTimeoutRef.current = null
    }

    if (isOpen) {
      return
    }

    resetTimeoutRef.current = window.setTimeout(() => {
      setRepoId('')
      setName('')
      setLinkedIssue('')
      setComment('')
      setCreateError(null)
      lastSuggestedNameRef.current = ''
      resetTimeoutRef.current = null
    }, DIALOG_CLOSE_RESET_DELAY_MS)

    return () => {
      if (resetTimeoutRef.current !== null) {
        window.clearTimeout(resetTimeoutRef.current)
        resetTimeoutRef.current = null
      }
    }
  }, [isOpen])

  // Focus and select name input when suggestion is applied
  React.useEffect(() => {
    if (!isOpen || !repoId || !suggestedName) {
      return
    }
    requestAnimationFrame(() => {
      const input = nameInputRef.current
      if (!input) {
        return
      }
      input.focus()
      input.select()
    })
  }, [isOpen, repoId, suggestedName])

  // Safety guard: creating a worktree requires at least one repo.
  React.useEffect(() => {
    if (isOpen && repos.length === 0) {
      handleOpenChange(false)
    }
  }, [isOpen, repos.length, handleOpenChange])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && repoId && name.trim() && !creating) {
        e.preventDefault()
        handleCreate()
      }
    },
    [repoId, name, creating, handleCreate]
  )

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md" onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle className="text-sm">New Worktree</DialogTitle>
          <DialogDescription className="text-xs">
            Create a new git worktree on a fresh branch cut from the selected base ref.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* Repo selector */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">Repository</label>
            <Select value={repoId} onValueChange={handleRepoChange}>
              <SelectTrigger className="h-8 text-xs w-full">
                <SelectValue placeholder="Select repo...">
                  {selectedRepo ? (
                    <RepoDotLabel
                      name={selectedRepo.displayName}
                      color={selectedRepo.badgeColor}
                      dotClassName="size-1.5"
                    />
                  ) : null}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {repos.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    <RepoDotLabel name={r.displayName} color={r.badgeColor} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Name */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">Name</label>
            <Input
              ref={nameInputRef}
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="feature/my-feature"
              className="h-8 text-xs"
              autoFocus
            />
            {createError && <p className="text-[10px] text-destructive">{createError}</p>}
          </div>

          {/* Link GH Issue */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              Link GH Issue <span className="text-muted-foreground/50">(optional)</span>
            </label>
            <Input
              value={linkedIssue}
              onChange={(e) => setLinkedIssue(e.target.value)}
              placeholder="Issue # or GitHub URL"
              className="h-8 text-xs"
            />
            <p className="text-[10px] text-muted-foreground">
              Paste an issue URL, or enter a number.
            </p>
          </div>

          {/* Comment */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              Comment <span className="text-muted-foreground/50">(optional)</span>
            </label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Notes about this worktree..."
              rows={2}
              className="w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 resize-none"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenChange(false)}
            className="text-xs"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={!repoId || !name.trim() || creating}
            className="text-xs"
          >
            {creating ? 'Creating...' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default AddWorktreeDialog

function getSuggestedSpaceName(
  repoId: string,
  worktreesByRepo: Record<string, { path: string }[]>,
  nestWorkspaces: boolean
): string {
  if (!repoId) {
    return SPACE_NAMES[0]
  }

  const usedNames = new Set<string>()
  const repoWorktrees = worktreesByRepo[repoId] ?? []

  for (const worktree of repoWorktrees) {
    usedNames.add(normalizeSpaceName(lastPathSegment(worktree.path)))
  }

  if (!nestWorkspaces) {
    for (const worktrees of Object.values(worktreesByRepo)) {
      for (const worktree of worktrees) {
        usedNames.add(normalizeSpaceName(lastPathSegment(worktree.path)))
      }
    }
  }

  for (const candidate of SPACE_NAMES) {
    if (!usedNames.has(normalizeSpaceName(candidate))) {
      return candidate
    }
  }

  let suffix = 2
  while (true) {
    for (const candidate of SPACE_NAMES) {
      const numberedCandidate = `${candidate}-${suffix}`
      if (!usedNames.has(normalizeSpaceName(numberedCandidate))) {
        return numberedCandidate
      }
    }
    suffix += 1
  }
}

function lastPathSegment(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? path
}

function normalizeSpaceName(name: string): string {
  return name.trim().toLowerCase()
}

function findRepoIdForWorktree(
  worktreeId: string | null,
  worktreesByRepo: Record<string, { id: string }[]>
): string | null {
  if (!worktreeId) {
    return null
  }

  for (const [repoId, worktrees] of Object.entries(worktreesByRepo)) {
    if (worktrees.some((worktree) => worktree.id === worktreeId)) {
      return repoId
    }
  }

  return null
}

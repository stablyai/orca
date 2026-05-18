import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { parseGitHubIssueOrPRLink, parseGitHubIssueOrPRNumber } from '@/lib/github-links'
import { ExternalLink, LoaderCircle } from 'lucide-react'
import type { WorktreeMeta } from '../../../../shared/types'

function parseExplicitGitHubIssueUrl(input: string): string | null {
  const trimmed = input.trim()
  const link = parseGitHubIssueOrPRLink(trimmed)
  if (!link || link.type !== 'issue') {
    return null
  }

  return trimmed
}

const WorktreeMetaDialog = React.memo(function WorktreeMetaDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const fetchIssue = useAppStore((s) => s.fetchIssue)

  const isEditMeta = activeModal === 'edit-meta'
  const isOpen = isEditMeta

  const worktreeId = typeof modalData.worktreeId === 'string' ? modalData.worktreeId : ''
  const currentDisplayName =
    typeof modalData.currentDisplayName === 'string' ? modalData.currentDisplayName : ''
  const currentIssue =
    typeof modalData.currentIssue === 'number' ? String(modalData.currentIssue) : ''
  const currentPR = typeof modalData.currentPR === 'number' ? String(modalData.currentPR) : ''
  const currentComment =
    typeof modalData.currentComment === 'string' ? modalData.currentComment : ''
  const focusField = typeof modalData.focus === 'string' ? modalData.focus : 'comment'

  const [displayNameInput, setDisplayNameInput] = useState('')
  const [issueInput, setIssueInput] = useState('')
  const [prInput, setPrInput] = useState('')
  const [commentInput, setCommentInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [openingIssue, setOpeningIssue] = useState(false)
  const isMac = navigator.userAgent.includes('Mac')

  const issueInputRef = useRef<HTMLInputElement>(null)
  const prInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const prevIsOpenRef = useRef(false)
  const displayNameInputRef = useRef<HTMLInputElement>(null)
  if (isOpen && !prevIsOpenRef.current) {
    setDisplayNameInput(currentDisplayName)
    setIssueInput(currentIssue)
    setPrInput(currentPR)
    setCommentInput(currentComment)
    setOpeningIssue(false)
  }
  prevIsOpenRef.current = isOpen

  const issueNumber = useMemo(() => parseGitHubIssueOrPRNumber(issueInput), [issueInput])
  const issueUrlFromInput = useMemo(() => parseExplicitGitHubIssueUrl(issueInput), [issueInput])
  const issueInputLooksLikeUrl = useMemo(
    () => /^https?:\/\//i.test(issueInput.trim()),
    [issueInput]
  )
  const issueRepo = useAppStore((s) => {
    const worktree = Object.values(s.worktreesByRepo)
      .flat()
      .find((item) => item.id === worktreeId)
    if (!worktree) {
      return undefined
    }
    return s.repos.find((repo) => repo.id === worktree.repoId)
  })
  const cachedIssueUrl = useAppStore((s) => {
    if (!issueRepo || issueNumber === null) {
      return null
    }
    return s.issueCache[`${issueRepo.id}::${issueNumber}`]?.data?.url ?? null
  })
  const canOpenIssue = issueInputLooksLikeUrl
    ? Boolean(issueUrlFromInput)
    : Boolean(cachedIssueUrl || (issueRepo && issueNumber))

  const autoResize = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) {
      return
    }
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [])

  useEffect(() => {
    if (isEditMeta) {
      autoResize()
    }
  }, [isEditMeta, commentInput, autoResize])

  const canSave = useMemo(() => {
    if (!worktreeId) {
      return false
    }
    const trimmedIssue = issueInput.trim()
    const trimmedPR = prInput.trim()
    const issueValid = trimmedIssue === '' || parseGitHubIssueOrPRNumber(trimmedIssue) !== null
    const prValid = trimmedPR === '' || parseGitHubIssueOrPRNumber(trimmedPR) !== null
    return issueValid && prValid
  }, [worktreeId, issueInput, prInput])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal()
      }
    },
    [closeModal]
  )

  const handleSave = useCallback(async () => {
    if (!canSave) {
      return
    }
    setSaving(true)
    try {
      const trimmedIssue = issueInput.trim()
      const linkedIssueNumber = parseGitHubIssueOrPRNumber(trimmedIssue)
      const finalLinkedIssue =
        trimmedIssue === '' ? null : linkedIssueNumber !== null ? linkedIssueNumber : undefined
      const trimmedPR = prInput.trim()
      const linkedPRNumber = parseGitHubIssueOrPRNumber(trimmedPR)
      const finalLinkedPR =
        trimmedPR === '' ? null : linkedPRNumber !== null ? linkedPRNumber : undefined

      const trimmedDisplayName = displayNameInput.trim()
      const updates: Partial<WorktreeMeta> = {
        comment: commentInput.trim(),
        ...(trimmedDisplayName !== currentDisplayName && {
          displayName: trimmedDisplayName || undefined
        })
      }
      if (finalLinkedIssue !== undefined) {
        updates.linkedIssue = finalLinkedIssue
      }
      if (finalLinkedPR !== undefined) {
        updates.linkedPR = finalLinkedPR
      }

      await updateWorktreeMeta(worktreeId, updates)
      closeModal()
    } finally {
      setSaving(false)
    }
  }, [
    worktreeId,
    canSave,
    displayNameInput,
    currentDisplayName,
    issueInput,
    prInput,
    commentInput,
    updateWorktreeMeta,
    closeModal
  ])

  const handleCommentKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
        e.preventDefault()
        e.stopPropagation()
        handleSave()
      }
    },
    [handleSave]
  )

  const handleIssueKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleSave()
      }
    },
    [handleSave]
  )

  const handleOpenIssue = useCallback(async () => {
    if (openingIssue) {
      return
    }

    if (issueUrlFromInput) {
      void window.api.shell.openUrl(issueUrlFromInput)
      return
    }

    if (issueInputLooksLikeUrl) {
      return
    }

    if (cachedIssueUrl) {
      void window.api.shell.openUrl(cachedIssueUrl)
      return
    }

    if (!issueRepo || issueNumber === null) {
      return
    }

    setOpeningIssue(true)
    try {
      const issue = await fetchIssue(issueRepo.path, issueNumber, { repoId: issueRepo.id })
      if (issue?.url) {
        void window.api.shell.openUrl(issue.url)
      }
    } finally {
      setOpeningIssue(false)
    }
  }, [
    cachedIssueUrl,
    fetchIssue,
    issueInputLooksLikeUrl,
    issueNumber,
    issueRepo,
    issueUrlFromInput,
    openingIssue
  ])

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-md"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          if (focusField === 'displayName') {
            displayNameInputRef.current?.focus()
          } else if (focusField === 'issue') {
            issueInputRef.current?.focus()
          } else if (focusField === 'pr') {
            prInputRef.current?.focus()
          } else {
            textareaRef.current?.focus()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">Edit Worktree Details</DialogTitle>
          <DialogDescription className="text-xs">
            Edit GitHub links and notes for this worktree.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">Display Name</label>
            <Input
              ref={displayNameInputRef}
              value={displayNameInput}
              onChange={(e) => setDisplayNameInput(e.target.value)}
              onKeyDown={handleIssueKeyDown}
              placeholder="Custom display name..."
              className="h-8 text-xs"
            />
            <p className="text-[10px] text-muted-foreground">
              Only changes the name shown in the sidebar — the folder on disk stays the same. Leave
              blank to use the branch or folder name.
            </p>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">GH Issue</label>
            <div className="relative">
              <Input
                ref={issueInputRef}
                value={issueInput}
                onChange={(e) => setIssueInput(e.target.value)}
                onKeyDown={handleIssueKeyDown}
                placeholder="Issue # or GitHub URL"
                className="h-8 pr-9 text-xs"
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Open GitHub issue"
                    disabled={!canOpenIssue || openingIssue}
                    onClick={handleOpenIssue}
                    className="absolute right-1 top-1 text-muted-foreground"
                  >
                    {openingIssue ? (
                      <LoaderCircle className="size-3 animate-spin" />
                    ) : (
                      <ExternalLink className="size-3" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  Open GitHub issue
                </TooltipContent>
              </Tooltip>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Paste an issue URL, or enter a number. Leave blank to remove the link.
            </p>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">GH PR</label>
            <Input
              ref={prInputRef}
              value={prInput}
              onChange={(e) => setPrInput(e.target.value)}
              onKeyDown={handleIssueKeyDown}
              placeholder="PR # or GitHub URL"
              className="h-8 text-xs"
            />
            <p className="text-[10px] text-muted-foreground">
              Paste a pull request URL, or enter a number. Leave blank to remove the link.
            </p>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">Comment</label>
            <textarea
              ref={textareaRef}
              value={commentInput}
              onChange={(e) => setCommentInput(e.target.value)}
              onKeyDown={handleCommentKeyDown}
              placeholder="Notes about this worktree..."
              rows={3}
              className="w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 resize-none max-h-60 overflow-y-auto"
            />
            <p className="text-[10px] text-muted-foreground">
              Supports **markdown** — bold, lists, `code`, links. Press Enter or{' '}
              {isMac ? 'Cmd' : 'Ctrl'}+Enter to save, Shift+Enter for a new line.
            </p>
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
          <Button size="sm" onClick={handleSave} disabled={!canSave || saving} className="text-xs">
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default WorktreeMetaDialog

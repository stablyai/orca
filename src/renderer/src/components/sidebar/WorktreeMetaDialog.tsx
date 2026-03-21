import React, { useCallback, useMemo, useRef, useState } from 'react'
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
import { parseGitHubIssueOrPRNumber } from '@/lib/github-links'

const WorktreeMetaDialog = React.memo(function WorktreeMetaDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)

  const isLinkIssue = activeModal === 'link-issue'
  const isEditComment = activeModal === 'edit-comment'
  const isOpen = isLinkIssue || isEditComment

  const worktreeId = typeof modalData.worktreeId === 'string' ? modalData.worktreeId : ''
  const currentIssue =
    typeof modalData.currentIssue === 'number' ? String(modalData.currentIssue) : ''
  const currentComment =
    typeof modalData.currentComment === 'string' ? modalData.currentComment : ''

  const [issueInput, setIssueInput] = useState('')
  const [commentInput, setCommentInput] = useState('')
  const [saving, setSaving] = useState(false)

  const prevIsOpenRef = useRef(false)
  if (isOpen && !prevIsOpenRef.current) {
    setIssueInput(currentIssue)
    setCommentInput(currentComment)
  }
  prevIsOpenRef.current = isOpen

  const canSave = useMemo(() => {
    if (!worktreeId) return false
    if (isLinkIssue)
      return issueInput.trim() === '' || parseGitHubIssueOrPRNumber(issueInput) !== null
    return true
  }, [worktreeId, isLinkIssue, issueInput])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) closeModal()
    },
    [closeModal]
  )

  const handleSave = useCallback(async () => {
    if (!worktreeId) return
    setSaving(true)
    try {
      if (isLinkIssue) {
        const trimmed = issueInput.trim()
        const linkedIssueNumber = parseGitHubIssueOrPRNumber(trimmed)
        if (trimmed === '' || linkedIssueNumber !== null) {
          await updateWorktreeMeta(worktreeId, { linkedIssue: linkedIssueNumber })
        }
      } else if (isEditComment) {
        await updateWorktreeMeta(worktreeId, { comment: commentInput.trim() })
      }
      closeModal()
    } finally {
      setSaving(false)
    }
  }, [
    worktreeId,
    isLinkIssue,
    isEditComment,
    issueInput,
    commentInput,
    updateWorktreeMeta,
    closeModal
  ])

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {isLinkIssue ? 'Link GH Issue/PR' : 'Edit Comment'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {isLinkIssue
              ? 'Add an issue/PR number or URL to link this worktree. Leave blank to remove the link.'
              : 'Add or edit notes for this worktree.'}
          </DialogDescription>
        </DialogHeader>

        {isLinkIssue ? (
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">GH Issue / PR</label>
            <Input
              value={issueInput}
              onChange={(e) => setIssueInput(e.target.value)}
              placeholder="Issue/PR # or GitHub URL"
              className="h-8 text-xs"
              autoFocus
            />
            <p className="text-[10px] text-muted-foreground">
              Paste an issue or PR URL, or enter a number.
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">Comment</label>
            <textarea
              value={commentInput}
              onChange={(e) => setCommentInput(e.target.value)}
              placeholder="Notes about this worktree..."
              rows={3}
              autoFocus
              className="w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 resize-none"
            />
          </div>
        )}

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

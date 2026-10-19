import React, { useCallback, useRef, useState } from 'react'
import { getWorktreeMetaDialogOwner } from './worktree-meta-dialog-owner'
import { Plus } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { useWorktreeMetaWorkspace } from './use-worktree-meta-workspace'
import { getScreenSubmitShortcutLabel, isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import {
  getWorktreeExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import { findIndexedRepoOwnerForHost } from '@/lib/worktree-runtime-owner-index'
import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments'
import type { WorkspaceAttachment } from '../../../../shared/worktree/types'
import { WorktreeDisplayNameField } from './WorktreeDisplayNameField'
import { WorktreeLinkedItemsField } from './WorktreeLinkedItemsField'
import { buildWorkspaceAttachmentEdits } from './worktree-attachment-editing'
import { resizeCommentTextarea } from './worktree-comment-textarea-sizing'
import {
  isImeOwnedKeyboardEvent,
  useImeEnterGestureOwnership
} from '@/lib/ime-composition-keyboard-event'

const WorktreeMetaDialogDraft = React.memo(function WorktreeMetaDialogDraft() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const isOpen = activeModal === 'edit-meta'
  const dialogOwner = getWorktreeMetaDialogOwner({ activeModal, modalData })
  const worktreeId = typeof modalData.worktreeId === 'string' ? modalData.worktreeId : ''
  const ownerRepoId = typeof modalData.repoId === 'string' ? modalData.repoId : null
  const executionHostId =
    typeof modalData.executionHostId === 'string'
      ? (parseExecutionHostId(modalData.executionHostId)?.id ?? undefined)
      : undefined
  const focusField = typeof modalData.focus === 'string' ? modalData.focus : 'comment'
  const suppressHostedReviewRefresh = modalData.suppressHostedReviewRefresh === true
  const suggestedReviewNumber =
    typeof modalData.currentReview === 'number'
      ? modalData.currentReview
      : typeof modalData.currentPR === 'number'
        ? modalData.currentPR
        : null
  const suggestedReviewProvider = modalData.reviewProvider === 'gitlab' ? 'gitlab' : 'github'
  const { worktree, isFolderWorkspace } = useWorktreeMetaWorkspace({
    worktreeId,
    ownerRepoId,
    executionHostId
  })
  const repo = useAppStore((s) =>
    worktree && !isFolderWorkspace
      ? (findIndexedRepoOwnerForHost(
          s.repos,
          worktree.repoId,
          worktree.runtimeOwnerEnvironmentId
            ? toRuntimeExecutionHostId(worktree.runtimeOwnerEnvironmentId)
            : (executionHostId ?? getWorktreeExecutionHostId(worktree, undefined))
        ) ?? undefined)
      : undefined
  )
  const [initial] = useState(() => ({
    displayName:
      typeof modalData.currentDisplayName === 'string'
        ? modalData.currentDisplayName
        : (worktree?.displayName ?? ''),
    comment:
      typeof modalData.currentComment === 'string'
        ? modalData.currentComment
        : (worktree?.comment ?? ''),
    items: getWorkspaceAttachments(worktree ?? {})
  }))
  const [displayNameInput, setDisplayNameInput] = useState(initial.displayName)
  const [commentInput, setCommentInput] = useState(initial.comment)
  const [items, setItems] = useState<WorkspaceAttachment[]>(initial.items)
  const [notesOpen, setNotesOpen] = useState(
    Boolean(initial.comment.trim()) || focusField === 'comment'
  )
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [dialogElement, setDialogElement] = useState<HTMLElement | null>(null)
  const displayNameInputRef = useRef<HTMLInputElement>(null)
  const linkInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const focusNotesOnMountRef = useRef(false)
  const mountedRef = useMountedRef()
  const commentIme = useImeEnterGestureOwnership()

  const handleSave = async (): Promise<void> => {
    if (!worktreeId || !worktree || saving) {
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const updates = {
        ...(displayNameInput.trim() !== initial.displayName
          ? { displayName: displayNameInput.trim() }
          : {}),
        ...(commentInput.trim() !== initial.comment ? { comment: commentInput.trim() } : {}),
        ...buildWorkspaceAttachmentEdits({
          initial: initial.items,
          draft: items
        })
      }
      const result =
        executionHostId || suppressHostedReviewRefresh
          ? await updateWorktreeMeta(worktreeId, updates, {
              ...(executionHostId ? { executionHostId } : {}),
              ...(suppressHostedReviewRefresh ? { suppressHostedReviewRefresh: true } : {})
            })
          : await updateWorktreeMeta(worktreeId, updates)
      if (
        !mountedRef.current ||
        getWorktreeMetaDialogOwner(useAppStore.getState()) !== dialogOwner
      ) {
        return
      }
      if (!result.ok) {
        if (mountedRef.current) {
          setSaveError(result.error)
        }
        return
      }
      closeModal()
      if (typeof modalData.afterSave === 'function') {
        try {
          void Promise.resolve(modalData.afterSave({ worktreeId, updates })).catch(console.error)
        } catch (error) {
          console.error(error)
        }
      }
    } finally {
      if (mountedRef.current) {
        setSaving(false)
      }
    }
  }

  const setCommentTextareaRef = useCallback(
    (textarea: HTMLTextAreaElement | null) => {
      textareaRef.current = textarea
      if (textarea && isOpen) {
        resizeCommentTextarea(textarea)
        if (focusNotesOnMountRef.current) {
          focusNotesOnMountRef.current = false
          textarea.focus()
        }
      }
    },
    [isOpen]
  )

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open && !saving) {
          closeModal()
        }
      }}
    >
      <DialogContent
        ref={setDialogElement}
        className="max-h-[calc(100vh-3rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-[640px]"
        onEscapeKeyDown={(event) => {
          const search = linkInputRef.current
          if (
            isImeOwnedKeyboardEvent(event) ||
            textareaRef.current?.dataset.imeComposing === 'true' ||
            search?.dataset.imeComposing === 'true' ||
            (event.target === search && Boolean(search?.value))
          ) {
            event.preventDefault()
          }
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          if (focusField === 'displayName') {
            displayNameInputRef.current?.focus()
          } else if (focusField === 'issue' || focusField === 'pr' || focusField === 'links') {
            linkInputRef.current?.focus()
          } else {
            textareaRef.current?.focus()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{translate('workspace.links.details', 'Workspace details')}</DialogTitle>
          <DialogDescription>
            {translate(
              'workspace.links.description',
              'Attach reviews and tasks, and keep notes for this workspace.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto scrollbar-sleek">
          <WorktreeDisplayNameField
            disabled={saving}
            inputRef={displayNameInputRef}
            onEnter={handleSave}
            onValueChange={setDisplayNameInput}
            portalContainer={dialogElement}
            value={displayNameInput}
          />
          <WorktreeLinkedItemsField
            key={`${worktreeId}:${isOpen}`}
            items={items}
            onItemsChange={setItems}
            onSave={handleSave}
            repo={repo}
            workspace={worktree}
            isFolderWorkspace={isFolderWorkspace}
            inputRef={linkInputRef}
            initialInput={
              suggestedReviewNumber !== null &&
              !items.some(
                (item) =>
                  item.provider === suggestedReviewProvider &&
                  item.type !== 'issue' &&
                  item.number === suggestedReviewNumber
              )
                ? String(suggestedReviewNumber)
                : ''
            }
            initialKind={
              focusField === 'pr'
                ? modalData.reviewProvider === 'gitlab'
                  ? 'gitlab-mr'
                  : 'github-pr'
                : 'github-issue'
            }
            disabled={saving}
          />
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              {notesOpen ? (
                <Label htmlFor="workspace-comment">
                  {translate('workspace.links.notes', 'Notes')}
                </Label>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={saving}
                  onClick={() => {
                    focusNotesOnMountRef.current = true
                    setNotesOpen(true)
                  }}
                >
                  <Plus />
                  {translate('workspace.links.addNotes', 'Add notes')}
                </Button>
              )}
              <span className="text-xs text-muted-foreground">
                {translate('workspace.links.notesOptional', 'Optional · Markdown')}
              </span>
            </div>
            {notesOpen ? (
              <>
                <Textarea
                  id="workspace-comment"
                  ref={setCommentTextareaRef}
                  value={commentInput}
                  disabled={saving}
                  onChange={(event) => {
                    setCommentInput(event.target.value)
                    resizeCommentTextarea(event.currentTarget)
                  }}
                  onCompositionStart={(event) => {
                    commentIme.setComposing(true)
                    event.currentTarget.dataset.imeComposing = 'true'
                  }}
                  onCompositionEnd={(event) => {
                    commentIme.setComposing(false)
                    delete event.currentTarget.dataset.imeComposing
                  }}
                  onBlur={(event) => {
                    commentIme.reset()
                    delete event.currentTarget.dataset.imeComposing
                  }}
                  onKeyUp={commentIme.onKeyUp}
                  onKeyDown={(event) => {
                    if (
                      commentIme.ownsKeyDown(event) ||
                      isImeOwnedKeyboardEvent(event) ||
                      commentIme.isComposing()
                    ) {
                      return
                    }
                    const plainEnter =
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !event.altKey &&
                      !event.metaKey &&
                      !event.ctrlKey
                    if (plainEnter || isScreenSubmitShortcut(event)) {
                      event.preventDefault()
                      event.stopPropagation()
                      void handleSave()
                    }
                  }}
                  placeholder={translate(
                    'auto.components.sidebar.WorktreeMetaDialog.030d484fc0',
                    'Notes about this worktree...'
                  )}
                  rows={3}
                  className="max-h-60 resize-none"
                />
                <p className="text-[11px] text-muted-foreground">
                  {translate(
                    'workspace.links.commentHelp',
                    'Markdown supported. Enter or {{shortcut}} to save · Shift+Enter for a new line.',
                    { shortcut: getScreenSubmitShortcutLabel() }
                  )}
                </p>
              </>
            ) : null}
          </div>
        </div>
        <div className="space-y-2">
          {saveError ? (
            <p role="alert" className="text-xs text-destructive">
              {saveError}
            </p>
          ) : null}
          <DialogFooter>
            <p className="mr-auto text-xs text-muted-foreground">
              {translate('workspace.links.saveHint', 'Changes apply when you save')}
            </p>
            <Button variant="ghost" size="sm" disabled={saving} onClick={closeModal}>
              {translate('auto.components.sidebar.WorktreeMetaDialog.3db0a2a593', 'Cancel')}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!worktreeId || !worktree || saving}>
              {saving
                ? translate('auto.components.sidebar.WorktreeMetaDialog.61d6f612cf', 'Saving...')
                : translate('auto.components.sidebar.WorktreeMetaDialog.2174f17011', 'Save')}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
})

export default WorktreeMetaDialogDraft

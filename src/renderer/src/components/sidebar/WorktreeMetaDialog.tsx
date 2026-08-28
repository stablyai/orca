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
import { getDisplacedLinkLabels } from './worktree-issue-displacement'
import {
  buildWorktreeMetaUpdates,
  parseGitHubWorkItemNumberForMetaField,
  type WorktreeMetaDraft,
  type WorktreeMetaSavedPayload,
  type WorktreeMetaSnapshot
} from './worktree-meta-updates'
import { useWorktreeIssueLink } from './use-worktree-issue-link'
import { useWorktreeMetaWorkspace } from './use-worktree-meta-workspace'
import { WorktreeIssueLinkField } from './WorktreeIssueLinkField'
import { getScreenSubmitShortcutLabel, isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { isWorkItemLinkQueryTooLarge } from '../../../../shared/new-workspace/work-item-link-query-bounds'
import {
  getIssueLinkProviderFromUrl,
  parseIssueLinkInput,
  type IssueLinkProvider
} from '../../../../shared/issue-link-input'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { WorktreeDisplayNameField } from './WorktreeDisplayNameField'

function resizeCommentTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto'
  textarea.style.height = `${textarea.scrollHeight}px`
}

/** Only read before the first open, when nothing can be saved yet. */
const EMPTY_SNAPSHOT: WorktreeMetaSnapshot = {
  displayName: '',
  comment: '',
  issueInput: '',
  issueProvider: 'github'
}

const WorktreeMetaDialog = React.memo(function WorktreeMetaDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const submitShortcutLabel = getScreenSubmitShortcutLabel()

  const isEditMeta = activeModal === 'edit-meta'
  const isOpen = isEditMeta

  const worktreeId = typeof modalData.worktreeId === 'string' ? modalData.worktreeId : ''
  const executionHostId =
    typeof modalData.executionHostId === 'string'
      ? (parseExecutionHostId(modalData.executionHostId)?.id ?? undefined)
      : undefined
  const currentDisplayName =
    typeof modalData.currentDisplayName === 'string' ? modalData.currentDisplayName : ''
  const currentComment =
    typeof modalData.currentComment === 'string' ? modalData.currentComment : ''
  const focusField = typeof modalData.focus === 'string' ? modalData.focus : 'comment'
  const afterSave =
    typeof modalData.afterSave === 'function'
      ? (modalData.afterSave as (payload: WorktreeMetaSavedPayload) => void | Promise<void>)
      : null

  // Why: the opening row names its repo bucket for workspace IDs the owner index
  // reads as ambiguous across hosts.
  const ownerRepoId = typeof modalData.repoId === 'string' ? modalData.repoId : null
  const {
    worktree,
    linkedIssue,
    linkedLinearIssue,
    currentIssue,
    currentProvider,
    isFolderWorkspace,
    liveLinks
  } = useWorktreeMetaWorkspace({ worktreeId, ownerRepoId })
  // Why: ChecksPanel seeds the PR it is looking at, which may not be linked yet.
  const currentPR =
    typeof modalData.currentPR === 'number'
      ? String(modalData.currentPR)
      : worktree?.linkedPR != null
        ? String(worktree.linkedPR)
        : ''

  const [displayNameInput, setDisplayNameInput] = useState('')
  const [issueInput, setIssueInput] = useState('')
  const [issueProvider, setIssueProvider] = useState<IssueLinkProvider>('github')
  const [prInput, setPrInput] = useState('')
  const [commentInput, setCommentInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<WorktreeMetaSnapshot>(EMPTY_SNAPSHOT)
  const [dialogElement, setDialogElement] = useState<HTMLElement | null>(null)
  const { canOpenIssue, openingIssue, openIssueFailed, handleOpenIssue, resetOpeningIssue } =
    useWorktreeIssueLink({
      worktreeId,
      ownerRepoId,
      issueInput,
      issueProvider,
      linearOrganizationUrlKey: worktree?.linkedLinearIssueOrganizationUrlKey ?? null,
      linkedLinearIssue: worktree?.linkedLinearIssue ?? null,
      linearSourceContext: worktree?.linkedTaskSourceContext ?? null
    })

  const issueInputRef = useRef<HTMLInputElement>(null)
  const prInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const prevIsOpenRef = useRef(false)
  const displayNameInputRef = useRef<HTMLInputElement>(null)
  const mountedRef = useMountedRef()
  if (isOpen && !prevIsOpenRef.current) {
    setDisplayNameInput(currentDisplayName)
    setIssueInput(currentIssue)
    setIssueProvider(currentProvider)
    setPrInput(currentPR)
    setCommentInput(currentComment)
    // Why: the baseline is frozen with the seed instead of tracking the store.
    // A background `orca worktree set --linear-issue` while the dialog is open
    // would otherwise move it, making the untouched field read as dirty — and
    // the next comment-only save would write the stale seed back over the new link.
    setSnapshot({
      displayName: currentDisplayName,
      comment: currentComment,
      issueInput: currentIssue,
      issueProvider: currentProvider,
      linkedLinearIssueOrganizationUrlKey: worktree?.linkedLinearIssueOrganizationUrlKey ?? null
    })
    setSaveError(null)
    resetOpeningIssue()
  }
  prevIsOpenRef.current = isOpen

  const draft = useMemo<WorktreeMetaDraft>(
    () => ({ displayNameInput, issueInput, issueProvider, prInput, commentInput }),
    [displayNameInput, issueInput, issueProvider, prInput, commentInput]
  )

  // Why: a URL names its provider unambiguously. A bare key does not — Linear
  // and Jira identifiers are the same shape — so typing never steers the chip.
  const handleIssueInputChange = useCallback((next: string) => {
    setIssueInput(next)
    // Why: the same bound the save gate applies. Detection parses on every
    // keystroke, and the field accepts pasted URLs of any length.
    const detected = isWorkItemLinkQueryTooLarge(next) ? null : getIssueLinkProviderFromUrl(next)
    if (detected) {
      setIssueProvider(detected)
    }
  }, [])

  const setCommentTextareaRef = useCallback(
    (textarea: HTMLTextAreaElement | null) => {
      textareaRef.current = textarea
      if (textarea && isEditMeta) {
        resizeCommentTextarea(textarea)
      }
    },
    [isEditMeta]
  )

  const handleCommentChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setCommentInput(event.target.value)
    // Why: notes should grow in the same input event; a passive Effect leaves a stale height.
    resizeCommentTextarea(event.currentTarget)
  }, [])

  // Why: bound the parse before it runs on every keystroke — the field accepts
  // pasted URLs and has no length cap of its own.
  const issueInvalid = useMemo(() => {
    const trimmed = issueInput.trim()
    if (trimmed === '' || isFolderWorkspace) {
      return false
    }
    return (
      isWorkItemLinkQueryTooLarge(trimmed) || parseIssueLinkInput(trimmed, issueProvider) === null
    )
  }, [isFolderWorkspace, issueInput, issueProvider])

  const canSave = useMemo(() => {
    if (!worktreeId) {
      return false
    }
    const trimmedPR = prInput.trim()
    // Same quadratic-parse bound as the issue field — this runs on every keystroke.
    const prValid =
      trimmedPR === '' ||
      (!isWorkItemLinkQueryTooLarge(trimmedPR) &&
        parseGitHubWorkItemNumberForMetaField(trimmedPR, 'pr') !== null)
    return !issueInvalid && prValid
  }, [worktreeId, issueInvalid, prInput])

  const displacedLinkLabels = useMemo(
    () =>
      getDisplacedLinkLabels({
        draft,
        snapshot,
        isFolderWorkspace,
        linkedIssue,
        linkedLinearIssue
      }),
    [draft, snapshot, isFolderWorkspace, linkedIssue, linkedLinearIssue]
  )

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
    // Why: a stale failure from the previous attempt must not sit under the
    // spinner for the whole in-flight save.
    setSaveError(null)
    try {
      const updates = buildWorktreeMetaUpdates(draft, snapshot, liveLinks)

      const result = executionHostId
        ? await updateWorktreeMeta(worktreeId, updates, { executionHostId })
        : await updateWorktreeMeta(worktreeId, updates)
      // Why: a failed save refetches and reverts the optimistic write. Closing
      // here would report success for an edit that silently undid itself, and
      // would discard the name, comment and PR changes in the same payload.
      if (!result.ok) {
        if (mountedRef.current) {
          setSaveError(result.error)
        }
        return
      }
      closeModal()
      // Why: follow-up refreshes should not turn a successful metadata save
      // into a failed dialog.
      try {
        void Promise.resolve(afterSave?.({ worktreeId, updates })).catch(console.error)
      } catch (error) {
        console.error(error)
      }
    } finally {
      if (mountedRef.current) {
        setSaving(false)
      }
    }
  }, [
    worktreeId,
    executionHostId,
    canSave,
    draft,
    snapshot,
    liveLinks,
    updateWorktreeMeta,
    closeModal,
    afterSave,
    mountedRef
  ])

  const handleCommentKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const isPlainEnter = e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey
      if (isPlainEnter || isScreenSubmitShortcut(e)) {
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

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        ref={setDialogElement}
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
          <DialogTitle className="text-sm">
            {translate(
              'auto.components.sidebar.WorktreeMetaDialog.382fd11a3e',
              'Edit Worktree Details'
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.sidebar.WorktreeMetaDialog.a0d191b7a7',
              'Edit issue links, pull request links, and notes for this workspace.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <WorktreeDisplayNameField
            disabled={saving}
            inputRef={displayNameInputRef}
            onEnter={handleSave}
            onValueChange={setDisplayNameInput}
            portalContainer={dialogElement}
            value={displayNameInput}
          />

          <WorktreeIssueLinkField
            inputRef={issueInputRef}
            value={issueInput}
            provider={issueProvider}
            isInvalid={issueInvalid}
            displacedLinkLabels={displacedLinkLabels}
            isReadOnly={isFolderWorkspace}
            canOpenIssue={canOpenIssue}
            openingIssue={openingIssue}
            openIssueFailed={openIssueFailed}
            onValueChange={handleIssueInputChange}
            onProviderChange={setIssueProvider}
            onOpenIssue={handleOpenIssue}
            onKeyDown={handleIssueKeyDown}
          />

          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              {translate('auto.components.sidebar.WorktreeMetaDialog.1b91db7e14', 'GH PR')}
            </label>
            <Input
              ref={prInputRef}
              value={prInput}
              onChange={(e) => setPrInput(e.target.value)}
              onKeyDown={handleIssueKeyDown}
              placeholder={translate(
                'auto.components.sidebar.WorktreeMetaDialog.077a4f7b5c',
                'PR # or GitHub URL'
              )}
              className="h-8 text-xs"
            />
            <p className="text-[10px] text-muted-foreground">
              {translate(
                'auto.components.sidebar.WorktreeMetaDialog.5ae06f40fd',
                'Paste a pull request URL, or enter a number. Leave blank to remove the link.'
              )}
            </p>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              {translate('auto.components.sidebar.WorktreeMetaDialog.9c1d1e9b71', 'Comment')}
            </label>
            <textarea
              ref={setCommentTextareaRef}
              value={commentInput}
              onChange={handleCommentChange}
              onKeyDown={handleCommentKeyDown}
              placeholder={translate(
                'auto.components.sidebar.WorktreeMetaDialog.030d484fc0',
                'Notes about this worktree...'
              )}
              rows={3}
              className="w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 resize-none max-h-60 overflow-y-auto scrollbar-sleek"
            />
            <p className="text-[10px] text-muted-foreground">
              {translate(
                'auto.components.sidebar.WorktreeMetaDialog.7f0be5e9a6',
                'Supports **markdown** — bold, lists, `code`, links. Press Enter or'
              )}{' '}
              {submitShortcutLabel}{' '}
              {translate(
                'auto.components.sidebar.WorktreeMetaDialog.b48c271d39',
                'to save, Shift+Enter for a new line.'
              )}
            </p>
          </div>
        </div>

        {saveError ? (
          <p role="alert" className="text-[11px] leading-[15px] text-destructive">
            {saveError}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenChange(false)}
            className="text-xs"
          >
            {translate('auto.components.sidebar.WorktreeMetaDialog.3db0a2a593', 'Cancel')}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!canSave || saving} className="text-xs">
            {saving
              ? translate('auto.components.sidebar.WorktreeMetaDialog.61d6f612cf', 'Saving...')
              : translate('auto.components.sidebar.WorktreeMetaDialog.2174f17011', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default WorktreeMetaDialog

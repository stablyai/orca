import {
  diffCommentOwnerKey,
  type DiffCommentOwner
} from '@/store/slices/diff-comments/diff-comment-owner'
import type { DiffComment } from '../../../../../../shared/file-review/diff-comment-types'
import { Check, Copy, MessageSquare, Trash } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { persistConfirmationSkipPreference } from '@/components/dismiss/confirmation/confirmation-skip-preference'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DialogCancel } from '@/components/ui/dialog-parts'
import { Label } from '@/components/ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { NotesSendMenu, type NotesSendMenuScope } from '../../review-note-delivery/NotesSendMenu'
import type { MarkdownReviewNote } from '@/lib/editor/markdown/review-notes/markdown-review-notes'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'

const CLEAR_MARKDOWN_REVIEW_NOTES_SETTINGS_SECTION_ID =
  'general-skip-clear-markdown-review-notes-confirm'

type PendingClear = {
  owner: DiffCommentOwner
  scopeKey: string
  filePath: string
  notes: readonly DiffComment[]
  count: number
}

function getFileDisplayName(filePath: string): string {
  return filePath.split(/[\\/]/).at(-1) || filePath
}

async function runClearNotes(
  onClearNotes: (owner: DiffCommentOwner, notes: readonly DiffComment[]) => Promise<boolean>,
  owner: DiffCommentOwner,
  notes: readonly DiffComment[]
): Promise<boolean> {
  try {
    return await onClearNotes(owner, notes)
  } catch (error) {
    console.error('Failed to clear Markdown review notes:', error)
    return false
  }
}

type RichMarkdownReviewRailActionsProps = {
  owner: DiffCommentOwner | null
  worktreeId: string
  filePath: string
  noteCount: number
  notes: readonly DiffComment[]
  railOpen: boolean
  notesCopied: boolean
  unsentScope: NotesSendMenuScope<MarkdownReviewNote>[]
  onToggleRail: () => void
  onCopyNotes: () => void
  onClearNotes: (owner: DiffCommentOwner, notes: readonly DiffComment[]) => Promise<boolean>
  onDelivered: (notes: readonly MarkdownReviewNote[]) => void
}

export function RichMarkdownReviewRailActions({
  owner,
  worktreeId,
  filePath,
  noteCount,
  notes,
  railOpen,
  notesCopied,
  unsentScope,
  onToggleRail,
  onCopyNotes,
  onClearNotes,
  onDelivered
}: RichMarkdownReviewRailActionsProps): React.JSX.Element | null {
  const t = useTranslate()
  const dontAskAgainId = useId()
  const skipClearConfirm = useAppStore(
    (s) => s.settings?.skipClearMarkdownReviewNotesConfirm ?? false
  )
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const ownerKey = owner ? diffCommentOwnerKey(owner) : null
  const scopeKey = JSON.stringify([worktreeId, filePath, ownerKey])
  const [renderedScopeKey, setRenderedScopeKey] = useState(scopeKey)
  const [pendingClear, setPendingClear] = useState<PendingClear | null>(null)
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const [isClearing, setIsClearing] = useState(false)
  const clearingRef = useRef(false)

  // Reset before children render: a reused editor must never show another file's confirmation.
  if (renderedScopeKey !== scopeKey) {
    setRenderedScopeKey(scopeKey)
    setPendingClear(null)
    setDontAskAgain(false)
  }
  const activePending = pendingClear?.scopeKey === scopeKey ? pendingClear : null

  const executeClear = async (pending: PendingClear, rememberChoice: boolean): Promise<void> => {
    if (clearingRef.current) {
      return
    }
    clearingRef.current = true
    setIsClearing(true)
    const ok = await runClearNotes(onClearNotes, pending.owner, pending.notes)
    clearingRef.current = false
    setIsClearing(false)
    if (ok) {
      setPendingClear((current) => (current === pending ? null : current))
      setDontAskAgain(false)
      if (rememberChoice) {
        persistConfirmationSkipPreference({
          updates: { skipClearMarkdownReviewNotesConfirm: true },
          settingsSectionId: CLEAR_MARKDOWN_REVIEW_NOTES_SETTINGS_SECTION_ID,
          updateSettings,
          openSettingsPage,
          openSettingsTarget
        })
      }
    } else {
      toast.error(
        t('auto.components.right.sidebar.SourceControl.eae7a1da5f', 'Failed to clear notes.')
      )
    }
  }

  const requestClear = (): void => {
    if (!owner || notes.length === 0 || clearingRef.current) {
      return
    }
    // Keep explicit immutable-ish data snapshots, never a callback closed over a future file.
    const snapshot: PendingClear = {
      owner,
      scopeKey,
      filePath,
      notes: notes.map((note) => ({ ...note })),
      count: notes.length
    }
    if (skipClearConfirm) {
      void executeClear(snapshot, false)
      return
    }
    setDontAskAgain(false)
    setPendingClear(snapshot)
  }

  const confirmClear = async (): Promise<void> => {
    const pending = activePending
    if (!pending) {
      return
    }
    await executeClear(pending, dontAskAgain)
  }

  if (noteCount === 0 && activePending === null) {
    return null
  }

  return (
    <>
      {noteCount > 0 ? (
        <div className="rich-markdown-review-rail-actions">
          <button
            type="button"
            className="rich-markdown-review-rail-toggle"
            aria-label={
              railOpen
                ? t(
                    'auto.components.editor.RichMarkdownReviewRailActions.af02dc2456',
                    'Hide review notes'
                  )
                : t(
                    'auto.components.editor.RichMarkdownReviewRailActions.8aaf2c4c69',
                    'Show review notes'
                  )
            }
            aria-expanded={railOpen}
            title={
              railOpen
                ? t(
                    'auto.components.editor.RichMarkdownReviewRailActions.af02dc2456',
                    'Hide review notes'
                  )
                : t(
                    'auto.components.editor.RichMarkdownReviewRailActions.8aaf2c4c69',
                    'Show review notes'
                  )
            }
            onClick={onToggleRail}
          >
            <MessageSquare className="size-3.5" />
            <span>{noteCount}</span>
          </button>
          <button
            type="button"
            className="rich-markdown-review-rail-action"
            title={
              notesCopied
                ? t(
                    'auto.components.editor.RichMarkdownReviewRailActions.a807596997',
                    'Copied notes'
                  )
                : t(
                    'auto.components.editor.RichMarkdownReviewRailActions.636394af72',
                    'Copy notes for agent'
                  )
            }
            aria-label={
              notesCopied
                ? t(
                    'auto.components.editor.RichMarkdownReviewRailActions.a807596997',
                    'Copied notes'
                  )
                : t(
                    'auto.components.editor.RichMarkdownReviewRailActions.636394af72',
                    'Copy notes for agent'
                  )
            }
            onClick={onCopyNotes}
          >
            {notesCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
          <NotesSendMenu
            owner={owner}
            worktreeId={worktreeId}
            groupId={worktreeId}
            modeIdParts={['markdown-notes', worktreeId, filePath, 'rail']}
            scopes={unsentScope}
            triggerClassName="rich-markdown-review-rail-action"
            onDelivered={onDelivered}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="rich-markdown-review-rail-action rich-markdown-review-rail-action-danger"
                aria-label={t(
                  'components.editor.RichMarkdownReviewRailActions.clearAllNotes',
                  'Clear all notes'
                )}
                disabled={!owner || noteCount === 0 || isClearing}
                onClick={requestClear}
              >
                <Trash className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {t(
                'components.editor.RichMarkdownReviewRailActions.clearAllNotes',
                'Clear all notes'
              )}
            </TooltipContent>
          </Tooltip>
        </div>
      ) : null}
      <Dialog
        open={activePending !== null}
        onOpenChange={(open) => {
          if (!open && !clearingRef.current) {
            setPendingClear(null)
            setDontAskAgain(false)
          }
        }}
      >
        <DialogContent size="confirm" initialFocus="cancel" busy={isClearing}>
          <DialogHeader>
            <DialogTitle className="break-words">
              {t(
                'auto.components.right.sidebar.SourceControl.clearNotesFromFile',
                'Clear {{count}} notes from {{path}}?',
                {
                  count: activePending?.count ?? 0,
                  path: getFileDisplayName(activePending?.filePath ?? filePath),
                  defaultValue_one: 'Clear {{count}} note from {{path}}?'
                }
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                'auto.components.right.sidebar.source.control.discard.dialog.0d2d88cba5',
                'This cannot be undone.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter
            start={
              <>
                <Checkbox
                  id={dontAskAgainId}
                  checked={dontAskAgain}
                  disabled={isClearing}
                  onCheckedChange={(checked) => setDontAskAgain(checked === true)}
                />
                <Label htmlFor={dontAskAgainId} variant="dialog-muted">
                  {t('auto.components.confirmation.dialog.92bac3217e', "Don't ask again")}
                </Label>
              </>
            }
          >
            <DialogCancel
              onClick={() => {
                setPendingClear(null)
                setDontAskAgain(false)
              }}
            >
              {t('auto.components.right.sidebar.SourceControl.05bb8f4a48', 'Cancel')}
            </DialogCancel>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={isClearing || !activePending}
              onClick={() => void confirmClear()}
            >
              {t('auto.components.right.sidebar.SourceControl.574d2f4413', 'Clear Notes')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

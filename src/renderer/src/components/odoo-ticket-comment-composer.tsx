import { useRef, useState, useCallback } from 'react'
import { LoaderCircle, Mail, Paperclip, StickyNote } from 'lucide-react'
import { toast } from 'sonner'

import {
  applyOdooMentionSelection,
  findOdooMentionQuery,
  resolveOdooMentionMarkup,
  type OdooMentionCandidate,
  type OdooMentionQuery
} from '@/components/odoo-comment-mention-query'
import {
  odooAttachmentDraftSetKey,
  readOdooAttachmentAsBase64,
  validateOdooAttachmentSelection,
  type OdooAttachmentDraft
} from '@/components/odoo-comment-attachment-draft'
import { OdooTicketComposerAttachments } from '@/components/odoo-ticket-composer-attachments'
import { OdooTicketMentionSuggestions } from '@/components/odoo-ticket-mention-suggestions'
import { useOdooCommentFileDrop } from '@/components/use-odoo-comment-file-drop'
import { useOdooMentionSuggestions } from '@/components/use-odoo-mention-suggestions'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { odooAddTicketComment, odooUploadTicketAttachments } from '@/runtime/runtime-odoo-client'
import { translate } from '@/i18n/i18n'
import type { OdooMentionSuggestion, OdooTicket } from '../../../shared/odoo-types'
/** Composer with a Message / Log note toggle mirroring Odoo's chatter tabs. */
export function OdooTicketCommentComposer({
  ticket,
  onPosted
}: {
  ticket: OdooTicket
  onPosted: () => void
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const [commentDraft, setCommentDraft] = useState('')
  // Default to an internal Log note (user preference): most chatter entries here
  // are internal notes, and a public message is the deliberate opt-in.
  const [commentIsNote, setCommentIsNote] = useState(true)
  const [commentPosting, setCommentPosting] = useState(false)
  const [mentionQuery, setMentionQuery] = useState<OdooMentionQuery | null>(null)
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0)
  // Kept as {id, name} rather than bare ids: the draft holds plain `@Name`, so
  // the name is what lets us re-find the mention at post time.
  const [pickedMentions, setPickedMentions] = useState<OdooMentionCandidate[]>([])
  const [attachmentDrafts, setAttachmentDrafts] = useState<OdooAttachmentDraft[]>([])
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // Why: uploads happen before the post. Without remembering them, a failed post
  // re-uploads the same files on the next submit and leaves an orphaned
  // ir.attachment on the ticket for every retry. Keyed on the draft set so
  // changing the selection invalidates it; only ever written from postComment.
  const uploadedAttachmentsRef = useRef<{ draftKey: string; ids: number[] } | null>(null)

  const { suggestions, loading: mentionLoading } = useOdooMentionSuggestions(ticket, mentionQuery)
  const mentionOpen = mentionQuery !== null

  // useCallback: the drop hook keeps this in a dependency, so a fresh
  // function each render would re-subscribe the window listener every time.
  const addAttachmentFiles = useCallback(
    (files: readonly File[]): void => {
      const existingBytes = attachmentDrafts.reduce((total, draft) => total + draft.size, 0)
      const { accepted, errors } = validateOdooAttachmentSelection(
        files,
        attachmentDrafts.length,
        existingBytes
      )
      if (accepted.length > 0) {
        setAttachmentDrafts((prev) => [...prev, ...accepted])
      }
      errors.forEach((message) => toast.error(message))
    },
    [attachmentDrafts]
  )

  const { isDragActive, contentRef, dragHandlers } = useOdooCommentFileDrop(
    true,
    addAttachmentFiles
  )

  const syncMentionQuery = (textarea: HTMLTextAreaElement): void => {
    setMentionQuery(findOdooMentionQuery(textarea.value, textarea.selectionStart))
    setMentionActiveIndex(0)
  }

  const chooseMention = (candidate: OdooMentionSuggestion): void => {
    const textarea = textareaRef.current
    const caret = textarea?.selectionStart ?? commentDraft.length
    if (!mentionQuery) {
      return
    }
    const result = applyOdooMentionSelection(commentDraft, caret, mentionQuery, candidate)
    setCommentDraft(result.value)
    setPickedMentions((prev) =>
      prev.some((entry) => entry.id === candidate.id)
        ? prev
        : [...prev, { id: candidate.id, name: candidate.name }]
    )
    setMentionQuery(null)
    requestAnimationFrame(() => {
      textarea?.focus()
      textarea?.setSelectionRange(result.caret, result.caret)
    })
  }

  const postComment = async (): Promise<void> => {
    const draft = commentDraft.trim()
    if (!draft || commentPosting) {
      return
    }
    // The draft carries plain `@Name` so it stays readable while typing; the
    // anchor markup Odoo needs is woven in here, and only for mentions the
    // author actually left in the text.
    const { body, partnerIds } = resolveOdooMentionMarkup(draft, pickedMentions)
    setCommentPosting(true)
    try {
      let attachmentIds: number[] | undefined
      if (attachmentDrafts.length > 0) {
        const draftKey = odooAttachmentDraftSetKey(attachmentDrafts)
        const alreadyUploaded = uploadedAttachmentsRef.current
        if (alreadyUploaded?.draftKey === draftKey) {
          attachmentIds = alreadyUploaded.ids
        } else {
          const uploads = await Promise.all(
            attachmentDrafts.map(async (draft) => ({
              name: draft.name,
              mimetype: draft.mimetype,
              data: await readOdooAttachmentAsBase64(draft.file)
            }))
          )
          const uploadResult = await odooUploadTicketAttachments(
            settings,
            ticket.id,
            uploads,
            ticket.instanceId
          )
          if (!uploadResult.ok) {
            toast.error(uploadResult.error)
            return
          }
          attachmentIds = uploadResult.ids
          uploadedAttachmentsRef.current = { draftKey, ids: uploadResult.ids }
        }
      }
      const result = await odooAddTicketComment(
        settings,
        ticket.id,
        body,
        commentIsNote,
        ticket.instanceId,
        partnerIds.length > 0 ? partnerIds : undefined,
        attachmentIds
      )
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setCommentDraft('')
      setPickedMentions([])
      setAttachmentDrafts([])
      uploadedAttachmentsRef.current = null
      toast.success(
        commentIsNote
          ? translate('auto.components.odoo.ticket.comment.composer.c49df753eb', 'Note logged.')
          : translate('auto.components.odoo.ticket.workspace.8b2db83b43', 'Comment posted.')
      )
      onPosted()
    } catch {
      toast.error(
        translate('auto.components.odoo.ticket.workspace.c243d3a215', 'Could not post the comment.')
      )
    } finally {
      setCommentPosting(false)
    }
  }

  return (
    <form
      className="flex flex-none flex-col border-t border-border/50"
      onSubmit={(event) => {
        event.preventDefault()
        void postComment()
      }}
    >
      <div
        ref={contentRef}
        className={cn('flex flex-col gap-2 px-5 py-3', isDragActive && 'bg-accent/40')}
        {...dragHandlers}
      >
        <div className="flex items-center gap-1 self-start rounded-md border border-border/60 p-0.5">
          {[
            {
              note: false,
              icon: <Mail className="size-3" />,
              label: translate('auto.components.odoo.ticket.comment.composer.7c2a8f723f', 'Message')
            },
            {
              note: true,
              icon: <StickyNote className="size-3" />,
              label: translate(
                'auto.components.odoo.ticket.comment.composer.04a559a66a',
                'Log note'
              )
            }
          ].map((mode) => {
            const active = commentIsNote === mode.note
            return (
              <button
                key={String(mode.note)}
                type="button"
                aria-pressed={active}
                onClick={() => setCommentIsNote(mode.note)}
                className={cn(
                  'inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition',
                  active
                    ? mode.note
                      ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                      : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {mode.icon}
                {mode.label}
              </button>
            )
          })}
        </div>
        <div className="relative">
          {mentionOpen ? (
            <OdooTicketMentionSuggestions
              suggestions={suggestions}
              activeIndex={mentionActiveIndex}
              loading={mentionLoading}
              onChoose={chooseMention}
            />
          ) : null}
          <textarea
            ref={textareaRef}
            value={commentDraft}
            onChange={(event) => {
              setCommentDraft(event.target.value)
              syncMentionQuery(event.currentTarget)
            }}
            onClick={(event) => syncMentionQuery(event.currentTarget)}
            onKeyUp={(event) => {
              if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) {
                syncMentionQuery(event.currentTarget)
              }
            }}
            placeholder={
              commentIsNote
                ? translate(
                    'auto.components.odoo.ticket.comment.composer.ff7fc2b56e',
                    'Log an internal note…'
                  )
                : translate('auto.components.odoo.ticket.workspace.1b5eaa43b5', 'Add a comment…')
            }
            rows={2}
            disabled={commentPosting}
            onKeyDown={(event) => {
              if (mentionOpen) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setMentionActiveIndex((index) => (index + 1) % Math.max(suggestions.length, 1))
                  return
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setMentionActiveIndex(
                    (index) =>
                      (index - 1 + Math.max(suggestions.length, 1)) %
                      Math.max(suggestions.length, 1)
                  )
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setMentionQuery(null)
                  return
                }
                if (event.key === 'Enter' && suggestions.length > 0) {
                  event.preventDefault()
                  chooseMention(suggestions[mentionActiveIndex] ?? suggestions[0])
                  return
                }
              }
              // Cross-platform submit: ⌘⏎ on Mac, Ctrl+Enter elsewhere.
              const submitModifier = navigator.userAgent.includes('Mac')
                ? event.metaKey
                : event.ctrlKey
              if (submitModifier && event.key === 'Enter') {
                event.preventDefault()
                void postComment()
              }
            }}
            className="min-h-10 w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </div>
        <OdooTicketComposerAttachments
          drafts={attachmentDrafts}
          disabled={commentPosting}
          onRemove={(id) => setAttachmentDrafts((prev) => prev.filter((draft) => draft.id !== id))}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = event.target.files
            if (files && files.length > 0) {
              addAttachmentFiles(Array.from(files))
            }
            event.target.value = ''
          }}
        />
        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={commentPosting}
            title={translate(
              'auto.components.odoo.ticket.comment.composer.b8735bb0f5',
              'Attach files'
            )}
            aria-label={translate(
              'auto.components.odoo.ticket.comment.composer.b8735bb0f5',
              'Attach files'
            )}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip className="size-4" />
          </Button>
          <Button type="submit" size="sm" disabled={!commentDraft.trim() || commentPosting}>
            {commentPosting ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : commentIsNote ? (
              translate('auto.components.odoo.ticket.comment.composer.04a559a66a', 'Log note')
            ) : (
              translate('auto.components.odoo.ticket.comment.composer.58e1f1d8b2', 'Send message')
            )}
          </Button>
        </div>
      </div>
    </form>
  )
}

import { Paperclip, X } from 'lucide-react'

import {
  formatOdooAttachmentSize,
  type OdooAttachmentDraft
} from '@/components/odoo-comment-attachment-draft'
import { translate } from '@/i18n/i18n'

/** Pending attachment chips in the composer, removable before the message is sent. */
export function OdooTicketComposerAttachments({
  drafts,
  disabled,
  onRemove
}: {
  drafts: OdooAttachmentDraft[]
  disabled: boolean
  onRemove: (id: string) => void
}): React.JSX.Element | null {
  if (drafts.length === 0) {
    return null
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {drafts.map((draft) => (
        <span
          key={draft.id}
          className="flex max-w-[220px] items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1 text-xs text-foreground/80"
        >
          <Paperclip className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{draft.name}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {formatOdooAttachmentSize(draft.size)}
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRemove(draft.id)}
            aria-label={translate(
              'auto.components.odoo.ticket.composer.attachments.3f7df129bf',
              'Remove attachment'
            )}
            className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
    </div>
  )
}

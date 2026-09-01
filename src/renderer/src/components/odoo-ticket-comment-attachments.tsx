import { Paperclip } from 'lucide-react'

import type { OdooCommentAttachment } from '../../../shared/odoo-types'
/** Attachments already posted on a chatter message; click opens them via the OS handler. */
export function OdooTicketCommentAttachmentList({
  attachments
}: {
  attachments: OdooCommentAttachment[]
}): React.JSX.Element | null {
  if (attachments.length === 0) {
    return null
  }
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {attachments.map((attachment) => (
        <button
          key={attachment.id}
          type="button"
          onClick={() => window.api.shell.openUrl(attachment.url)}
          className="flex max-w-[220px] items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1 text-xs text-foreground/80 hover:bg-accent hover:text-accent-foreground"
        >
          <Paperclip className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{attachment.name}</span>
        </button>
      ))}
    </div>
  )
}

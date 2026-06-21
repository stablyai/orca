import { FileText, Paperclip, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { JcodeChatAttachment } from '../../../../shared/jcode-chat-types'
import type { SlashCommand } from './chat-slash-commands'

/** A short, human label for an attachment chip. */
function attachmentLabel(attachment: JcodeChatAttachment): string {
  return attachment.name || (attachment.kind === 'file' ? attachment.path : 'text')
}

/** Removable chips for the composer's pending attachments (files + text blobs),
 *  rendered above the textarea. Renders nothing when there are no attachments. */
export function ChatAttachmentChips({
  attachments,
  onRemove
}: {
  attachments: JcodeChatAttachment[]
  onRemove: (index: number) => void
}): React.JSX.Element | null {
  if (attachments.length === 0) {
    return null
  }
  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-1">
      {attachments.map((attachment, index) => (
        <span
          key={`${attachment.kind}-${index}-${attachmentLabel(attachment)}`}
          className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground"
          title={attachment.kind === 'file' ? attachment.path : attachment.name}
        >
          {attachment.kind === 'file' ? (
            <Paperclip className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <FileText className="size-3 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{attachmentLabel(attachment)}</span>
          <button
            type="button"
            aria-label="Remove attachment"
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
            onClick={() => onRemove(index)}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
    </div>
  )
}

/** The "/"-triggered quick-command popover, anchored above the textarea. */
export function SlashCommandPopover({
  matches,
  activeIndex,
  onHover,
  onPick
}: {
  matches: SlashCommand[]
  activeIndex: number
  onHover: (index: number) => void
  onPick: (command: SlashCommand) => void
}): React.JSX.Element {
  return (
    <div className="absolute bottom-full left-0 z-20 mb-1 w-full max-w-sm overflow-hidden rounded-lg border border-border bg-popover shadow-md">
      <div className="border-b border-border px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Orca quick commands
      </div>
      {matches.map((command, index) => (
        <button
          key={command.id}
          type="button"
          className={cn(
            'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm transition-colors',
            index === activeIndex ? 'bg-muted' : 'hover:bg-muted'
          )}
          onMouseEnter={() => onHover(index)}
          onMouseDown={(event) => {
            // mousedown so the textarea doesn't lose focus before we act.
            event.preventDefault()
            onPick(command)
          }}
        >
          <span className="font-medium">{command.label}</span>
          <span className="ml-auto text-xs text-muted-foreground">{command.hint}</span>
        </button>
      ))}
    </div>
  )
}

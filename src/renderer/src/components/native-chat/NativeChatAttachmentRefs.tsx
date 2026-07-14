import type React from 'react'
import { FileText, Image as ImageIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import {
  isAttachmentBlock,
  type NativeChatAttachmentBlock,
  type NativeChatBlock
} from '../../../../shared/native-chat-types'

/** Open a web-imported attachment through the main process. Guarded with
 *  optional chaining because the web build ships a Partial preload API where
 *  `chatImportAttachment` is undefined — a click there must not throw. */
function openAttachment(block: NativeChatAttachmentBlock): void {
  const open = window.api.chatImportAttachment?.open
  if (!open) {
    return
  }
  // Why: on the web client window.api is a fallback Proxy, so `open` is a truthy
  // stub that resolves `undefined` (not {ok}); `result?.ok` avoids an unhandled
  // rejection reading `.ok` of undefined, and still surfaces the failure toast.
  void open({ hash: block.hash, fileName: block.fileName, mime: block.mime }).then((result) => {
    if (!result?.ok) {
      toast.error(
        translate('components.native-chat.attachment.openFailed', 'Could not open attachment'),
        { description: result?.error }
      )
    }
  })
}

/** Web-imported attachment blocks rendered as clickable chips, mirroring the
 *  image-ref chip style. Image kind gets an image icon, file kind a document
 *  icon; clicking opens the stored blob with the OS default handler. */
export function NativeChatAttachmentRefs({
  blocks
}: {
  blocks: NativeChatBlock[]
}): React.JSX.Element | null {
  const attachments = blocks.filter(isAttachmentBlock)
  if (attachments.length === 0) {
    return null
  }
  // Self-contained provider so the chips render their fileName hint anywhere the
  // message list mounts, independent of an app-level TooltipProvider.
  return (
    <TooltipProvider>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {attachments.map((attachment, index) => {
          const Icon = attachment.kind === 'image' ? ImageIcon : FileText
          return (
            <Tooltip key={`${attachment.hash}-${index}`}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => openAttachment(attachment)}
                  className="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span className="truncate">{attachment.fileName}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {attachment.fileName}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </TooltipProvider>
  )
}

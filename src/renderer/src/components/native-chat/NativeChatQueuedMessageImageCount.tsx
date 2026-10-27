import { Image as ImageIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { QueuedMessageCard } from './structured-agent-session-queued-cards'
import { nativeChatImageLabel } from './native-chat-image-label'

export function queuedMessageImageCount(count: number): string {
  return translate('components.native-chat.queuedMessages.imageCount', '{{count}} images', {
    count
  })
}

/** Images are named in the tooltip, not drawn: the row stays one line. */
export function QueuedMessageImageCount({
  images
}: {
  images: NonNullable<QueuedMessageCard['images']>
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          tabIndex={0}
          aria-label={queuedMessageImageCount(images.length)}
          className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ImageIcon className="size-3.5" aria-hidden />
          <span aria-hidden>{images.length}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {images.map(nativeChatImageLabel).join(', ')}
      </TooltipContent>
    </Tooltip>
  )
}

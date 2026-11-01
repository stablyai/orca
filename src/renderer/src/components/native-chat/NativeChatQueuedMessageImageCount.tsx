import { Image as ImageIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { QueuedMessageCard } from '../../../../shared/structured-agent-session-queued-cards'
import { nativeChatImageLabel, nativeChatImageLabelCopy } from './native-chat-image-label'

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
          aria-label={nativeChatImageLabelCopy().imageCount(images.length)}
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

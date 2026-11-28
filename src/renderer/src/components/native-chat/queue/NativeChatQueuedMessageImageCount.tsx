import { Image as ImageIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import type { QueuedMessageCard } from '../../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import {
  nativeChatImageLabel,
  nativeChatImageLabelCopy
} from '../media/images/native-chat-image-label'
import { useTranslate } from '@/i18n/use-translate'

/** Images are named in the tooltip, not drawn: the row stays one line. */
export function QueuedMessageImageCount({
  images,
  className
}: {
  images: NonNullable<QueuedMessageCard['images']>
  /** A card's tool row pads it like its icon buttons, so its glyphs sit as far apart as theirs. */
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          tabIndex={0}
          aria-label={nativeChatImageLabelCopy(t).imageCount(images.length)}
          className={cn(
            'flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className
          )}
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

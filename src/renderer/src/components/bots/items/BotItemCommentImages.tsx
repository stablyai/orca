// A comment's images, fitted to the card: one at its own size, two side by side, more in rows of three,
// read from the bot's host. One or two carry user-supplied filenames outside chat.
// Past six, five show with a "+N" tile that shows the rest. A click opens chat's viewer over all of the
// comment's images.
import { useContext, useMemo, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { BotItemCommentImage } from '../../../../../shared/bots/bot-items'
import { isNativeChatPastedImagePath } from '../../../../../shared/native-chat/attachments/native-chat-image-label'
import {
  NativeChatImageTile,
  NativeChatImageViewer
} from '../../native-chat/media/images/NativeChatImageAttachments'
import { NativeChatMarkdownImageOwnerContext } from '../../native-chat/media/images/native-chat-markdown-image-owner'

const SHOWN = 5

const LAYOUT = {
  one: {
    grid: 'grid-cols-1 justify-items-start',
    tile: 'min-h-20 min-w-20 max-w-full',
    image: 'block h-auto max-h-[218px] w-auto max-w-full'
  },
  two: {
    grid: 'grid-cols-2',
    tile: 'aspect-[4/3] w-full overflow-hidden',
    image: 'size-full object-cover object-left-top'
  },
  many: {
    grid: 'grid-cols-3',
    tile: 'aspect-square w-full overflow-hidden',
    image: 'size-full object-cover object-left-top'
  }
} as const

export function BotItemCommentImages({
  images,
  inChat = false
}: {
  images: readonly BotItemCommentImage[]
  inChat?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const runtimeContext = useContext(NativeChatMarkdownImageOwnerContext)?.runtimeContext ?? null
  const [all, setAll] = useState(false)
  const [viewing, setViewing] = useState<number | null>(null)
  const blocks = useMemo(
    () =>
      images.map(({ path, name }) => ({
        type: 'image-ref' as const,
        path,
        alt: isNativeChatPastedImagePath(name) ? undefined : name
      })),
    [images]
  )
  if (images.length === 0) {
    return null
  }
  const folded = images.length > SHOWN + 1 && !all
  const layout = images.length === 1 ? LAYOUT.one : images.length === 2 ? LAYOUT.two : LAYOUT.many
  const captioned = !inChat && images.length <= 2
  const more =
    'flex aspect-square w-full items-center justify-center rounded-md border border-border bg-chat-canvas text-xs text-muted-foreground transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
  return (
    <div
      className={cn('mt-1.5 grid gap-1.5 first:mt-0', layout.grid)}
      data-bot-item-comment-images=""
    >
      {(folded ? blocks.slice(0, SHOWN) : blocks).map((block, index) => (
        <div key={block.path} className="flex min-w-0 max-w-full flex-col gap-0.5">
          <NativeChatImageTile
            block={block}
            runtimeContext={runtimeContext}
            onOpen={() => setViewing(index)}
            className={layout.tile}
            imageClassName={layout.image}
          />
          {captioned && block.alt ? (
            <span className="truncate text-2xs text-muted-foreground">{block.alt}</span>
          ) : null}
        </div>
      ))}
      {folded ? (
        <button type="button" className={more} onClick={() => setAll(true)}>
          +{images.length - SHOWN}
        </button>
      ) : images.length > SHOWN + 1 ? (
        <button type="button" className={more} onClick={() => setAll(false)}>
          {t('bots.items.comment.showLess', 'Show less')}
        </button>
      ) : null}
      <NativeChatImageViewer
        blocks={blocks}
        index={viewing}
        onIndexChange={setViewing}
        runtimeContext={runtimeContext}
      />
    </div>
  )
}

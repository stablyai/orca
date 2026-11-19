// A comment's images as chat shows a message's: thumbnails that open in the pan-and-zoom viewer, read
// from the bot's host. Past six, five show with a "+N" tile that shows the rest.
import { useContext, useMemo, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { BotItemCommentImage } from '../../../../../shared/bots/bot-items'
import type { NativeChatBlock } from '../../../../../shared/native-chat/native-chat-types'
import { NativeChatImageAttachments } from '../../native-chat/media/images/NativeChatImageAttachments'
import { NativeChatMarkdownImageOwnerContext } from '../../native-chat/media/images/native-chat-markdown-image-owner'

const SHOWN = 5

export function BotItemCommentImages({
  images
}: {
  images: readonly BotItemCommentImage[]
}): React.JSX.Element | null {
  const t = useTranslate()
  const owner = useContext(NativeChatMarkdownImageOwnerContext)
  const [all, setAll] = useState(false)
  const folded = images.length > SHOWN + 1 && !all
  const blocks = useMemo(
    (): NativeChatBlock[] =>
      (folded ? images.slice(0, SHOWN) : images).map(({ path, name }) => ({
        type: 'image-ref',
        path,
        alt: name
      })),
    [folded, images]
  )
  if (images.length === 0) {
    return null
  }
  const tile =
    'flex size-20 shrink-0 items-center justify-center rounded-md border border-border bg-chat-canvas text-xs text-muted-foreground transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      <NativeChatImageAttachments
        blocks={blocks}
        runtimeContext={owner?.runtimeContext ?? null}
        className="contents"
      />
      {folded ? (
        <button type="button" className={tile} onClick={() => setAll(true)}>
          +{images.length - SHOWN}
        </button>
      ) : images.length > SHOWN + 1 ? (
        <button type="button" className={tile} onClick={() => setAll(false)}>
          {t('bots.items.comment.showLess', 'Show less')}
        </button>
      ) : null}
    </div>
  )
}

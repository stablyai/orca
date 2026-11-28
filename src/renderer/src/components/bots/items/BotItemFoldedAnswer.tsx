// A line's answer folded to one row on the waiting ask's card ("✓ Question… → answer"), and what a
// held answer carries besides its words: its images as the comment box's thumbnails, numbered as in
// the box, and its files as the comment card's file links.
import { useContext } from 'react'
import { Check } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { basename } from '@/lib/path'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { botItemQuestionLine } from '../../../../../shared/bots/bot-item-ask'
import {
  botItemHeldAnswerShown,
  type BotItemHeldAnswer
} from '../../../../../shared/bots/bot-item-held-answers'
import { stripImagePromptMarker } from '../../../../../shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import { NativeChatImageAttachmentPreview } from '../../native-chat/attachments/chips/NativeChatImageAttachmentPreview'
import { NativeChatMarkdownImageOwnerContext } from '../../native-chat/media/images/native-chat-markdown-image-owner'
import { BotItemCommentFiles } from './BotItemCommentFiles'

/** A line's answer as its folded line shows it: a held one's words, with what rides along beside them;
 *  an answer given or on its way, as its words. */
export function botItemShownAnswer(answer: BotItemHeldAnswer | string): {
  words: string
  images: readonly string[]
  files: readonly string[]
} {
  if (typeof answer === 'string') {
    // A send on its way: its images show on its comment, so their marks go (an image alone keeps it).
    return { words: stripImagePromptMarker(answer).trim() || answer, images: [], files: [] }
  }
  const { words, files } = botItemHeldAnswerShown(answer)
  // Images or files alone read as their names.
  return {
    words: words || [...answer.images, ...files].map((path) => basename(path)).join(', '),
    images: answer.images,
    files
  }
}

/** "✓ Question… → answer" on one row: the question gives way (an ellipsis), the answer stays whole;
 *  a held answer's images and files show under it. A pick reopens on click; an answer given or on its
 *  way doesn't. */
export function BotItemFoldedLine({
  question,
  answer,
  onOpen
}: {
  question: string
  answer: BotItemHeldAnswer | string
  onOpen?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const line = botItemQuestionLine(question)
  const { words, images, files } = botItemShownAnswer(answer)
  const content = (
    <>
      <Check aria-hidden className="size-3 shrink-0 self-center text-status-success" />
      {/* The question takes only its text's width, the arrow right after it. When the row is short it
          gives way first, keeping at least 40%: an answer past 60% (less the check and arrow) gives
          way too. Both stay whole in the title. */}
      <span className="min-w-0 truncate">{line}</span>
      <span aria-hidden className="shrink-0">
        →
      </span>
      <span className="max-w-[calc(60%-2.5rem)] shrink-0 truncate text-foreground/72">{words}</span>
    </>
  )
  const row =
    'flex w-full min-w-0 items-baseline gap-1.5 text-left text-[13px] leading-[19px] text-muted-foreground'
  const folded = onOpen ? (
    <button
      type="button"
      title={`${line} → ${words}`}
      aria-label={t('bots.items.ask.changeAnswer', '{{question}}: {{answer}}. Change answer', {
        question: line,
        answer: words
      })}
      className={cn(
        row,
        // A hover fill a little past the text says it opens.
        '-mx-1.5 w-[calc(100%+0.75rem)] cursor-pointer rounded-md px-1.5 outline-none hover:bg-foreground/4 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50'
      )}
      onClick={onOpen}
    >
      {content}
    </button>
  ) : (
    <p title={`${line} → ${words}`} className={row}>
      {content}
    </p>
  )
  return (
    <>
      {folded}
      {/* Under the answer, past the check. */}
      <BotItemHeldAnswerAttachments images={images} files={files} className="pl-[18px]" />
    </>
  )
}

export function BotItemHeldAnswerAttachments({
  images,
  files,
  className
}: {
  images: readonly string[]
  files: readonly string[]
  className?: string
}): React.JSX.Element | null {
  const target = useContext(NativeChatMarkdownImageOwnerContext)?.runtimeContext?.target
  if (images.length === 0 && files.length === 0) {
    return null
  }
  const hostEnvironmentId = (target && runtimeTargetEnvironmentId(target)) ?? undefined
  return (
    <div className={className}>
      {images.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-2">
          {images.map((path, index) => (
            <NativeChatImageAttachmentPreview
              key={path}
              attachment={{ id: path, path }}
              hostEnvironmentId={hostEnvironmentId}
              number={index + 1}
            />
          ))}
        </div>
      ) : null}
      <BotItemCommentFiles paths={files} />
    </div>
  )
}

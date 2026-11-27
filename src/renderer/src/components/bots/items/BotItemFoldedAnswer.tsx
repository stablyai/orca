// A line's answer folded to one row on the waiting ask's card ("✓ Label: answer"), and what a
// held answer carries besides its words: its images as the comment box's thumbnails, numbered as in
// the box, and its files as the comment card's file links.
import { useContext } from 'react'
import { Check } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
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

/** The question's first line as an answered line's label, cut short so the answer keeps the room. */
function shortLabel(question: string): string {
  // "Ship it?: yes" reads badly: the question mark goes before the colon.
  const line = botItemQuestionLine(question).replace(/[?:：？\s]+$/u, '')
  return line.length > LABEL_MAX ? `${line.slice(0, LABEL_MAX - 1).trimEnd()}…` : line
}
const LABEL_MAX = 24

/** "✓ Label: answer", muted, wrapping to 2 lines at most; the whole of it in the title. A pick shows
 *  Change on hover or focus (always on touch); an answer given or on its way doesn't. A held answer's
 *  images and files show under it. */
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
  const label = shortLabel(question)
  const { words, images, files } = botItemShownAnswer(answer)
  return (
    <div className="group/answer">
      <div className="flex min-h-7 w-full min-w-0 items-start gap-2.5 py-1 text-[13px] leading-[19px]">
        {/* On the key column: the check's box matches the reply rows' key width and gap. */}
        <span className="flex h-[19px] w-4.5 shrink-0 items-center justify-center">
          <Check aria-hidden className="size-3.5 text-theme-accent" />
        </span>
        <span
          title={`${botItemQuestionLine(question)}: ${words}`}
          className="line-clamp-2 min-w-0 flex-1 text-foreground [overflow-wrap:anywhere]"
        >
          <span className="text-muted-foreground">{label}:</span> {words}
        </span>
        {onOpen ? (
          <button
            type="button"
            aria-label={t(
              'bots.items.ask.changeAnswer',
              '{{question}}: {{answer}}. Change answer',
              {
                question: label,
                answer: words
              }
            )}
            // Takes no room until hover or focus, so a short answer keeps one line; always shown on touch.
            className="sr-only -mr-1 shrink-0 rounded-sm px-1 text-xs leading-[19px] text-muted-foreground outline-none group-focus-within/answer:not-sr-only group-hover/answer:not-sr-only hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 [@media(hover:none)]:not-sr-only"
            onClick={onOpen}
          >
            {t('bots.items.ask.change', 'Change')}
          </button>
        ) : null}
      </div>
      {/* Under the answer, past the check. */}
      <BotItemHeldAnswerAttachments images={images} files={files} className="pl-7" />
    </div>
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

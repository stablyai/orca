// The comment box's reply mark while the agent's question waits: "Replying to: <question>", which
// shows its question in Activity or hides for it; and the check that the box's question placeholder
// fits on its one line.
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import { X } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { BotItemWaitingLine } from '../../../../../shared/bots/bot-item-question-answers'
import {
  glowNativeChatComposer,
  useNativeChatComposerGlow
} from '../../native-chat/native-chat-composer-glow'

export type BotItemWaitingQuestion = BotItemWaitingLine & {
  /** Who asked, for the box's placeholder when the answer is the owner's own words. */
  asker: string
}

export type BotItemReplyMark = {
  quote: BotItemWaitingQuestion | null
  hide: () => void
  show: () => void
  reveal: () => void
  glowing: boolean
  placeholder: string
}

/** The box's reply mark and placeholder for the waiting question, if any: the mark hides per question,
 *  and comes back with `show` (Type your answer); `reveal` shows its question in Activity; `glowing` is
 *  the composer's one glow. The question's placeholder gives way to the plain one where it would cut. */
export function useBotItemReplyMark(
  box: RefObject<HTMLDivElement | null>,
  question: BotItemWaitingQuestion | null,
  scopeKey: string,
  onReveal?: (eventId: string) => void
): BotItemReplyMark {
  const t = useTranslate()
  const [hidden, setHidden] = useState<string | null>(null)
  const long = question?.replies
    ? t('bots.items.comment.replyOrPick', 'Reply in your own words, or pick an option')
    : t('bots.items.comment.replyTo', 'Reply to {{name}}…', { name: question?.asker ?? '' })
  const fits = useTextFits(box, long)
  const glowing = useNativeChatComposerGlow(scopeKey)
  // A question with no quick replies is answered here: the box glows once when it shows.
  const openQuestion = question && !question.replies ? question.id : null
  useEffect(() => {
    if (openQuestion) {
      glowNativeChatComposer(scopeKey)
    }
  }, [openQuestion, scopeKey])
  // Typing carries on in the box.
  const focusText = (): void =>
    box.current?.querySelector<HTMLElement>('[contenteditable]')?.focus()
  return {
    quote: question && hidden !== question.id ? question : null,
    hide: () => {
      setHidden(question?.id ?? null)
      focusText()
    },
    show: () => setHidden(null),
    reveal: () => {
      if (question) {
        onReveal?.(question.eventId)
      }
      focusText()
    },
    glowing,
    placeholder: question && fits ? long : t('bots.items.comment.add', 'Add a comment…')
  }
}

export function BotItemReplyingTo({ mark }: { mark: BotItemReplyMark }): React.JSX.Element | null {
  const t = useTranslate()
  if (!mark.quote) {
    return null
  }
  const question = mark.quote.line
  return (
    // Two sibling buttons: the mark shows the question, its × hides the mark.
    <div className="mx-1 mb-0.5 mt-0.5 flex h-6 max-w-[calc(100%-8px)] min-w-0 items-center gap-1 self-start rounded-md bg-foreground/[0.06] pr-[3px] text-xs text-muted-foreground">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t(
              'bots.items.comment.replyingToShow',
              'Replying to: {{question}}. Show question',
              {
                question
              }
            )}
            className="flex h-full min-w-0 cursor-pointer items-center gap-2 rounded-md pl-2.5 pr-1 outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring/50"
            // A click leaves the caret where it was in the box.
            onMouseDown={(event) => event.preventDefault()}
            onClick={mark.reveal}
          >
            {/* The open question line's own mark. */}
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-agent-question" />
            <span className="min-w-0 truncate">
              {t('bots.items.comment.replyingTo', 'Replying to:')}{' '}
              <span className="text-foreground">{question}</span>
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {t('bots.items.comment.showQuestion', 'Show question')}
        </TooltipContent>
      </Tooltip>
      <button
        type="button"
        aria-label={t('bots.items.comment.hideReplyingTo', 'Hide')}
        className="flex size-[18px] shrink-0 items-center justify-center rounded-sm hover:bg-foreground/[0.08] hover:text-foreground"
        onClick={mark.hide}
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

let measureCanvas: HTMLCanvasElement | null = null

/** Whether `text` fits on one line of the editor, in its own font: a placeholder that would cut falls
 *  back to a shorter one. */
function useTextFits(box: RefObject<HTMLDivElement | null>, text: string): boolean {
  const [fits, setFits] = useState(true)
  useLayoutEffect(() => {
    const frame = box.current
    if (!frame) {
      return
    }
    // The editor mounts after the box, so it is found on each measure.
    const measure = (): void => {
      const node = frame.querySelector<HTMLElement>('[contenteditable]')
      if (!measureCanvas) {
        measureCanvas = document.createElement('canvas')
      }
      const context = measureCanvas.getContext('2d')
      if (!node || !context) {
        return
      }
      const style = getComputedStyle(node)
      // Canvas fonts take no line height, which the computed shorthand carries.
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      const room =
        node.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight)
      setFits(context.measureText(text).width <= room)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(frame)
    // The editor narrows without the frame when the attach button comes in.
    const editor = frame.querySelector('[contenteditable]')
    if (editor) {
      observer.observe(editor)
    }
    measure()
    return () => observer.disconnect()
  }, [box, text])
  return fits
}

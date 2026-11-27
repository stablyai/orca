// The comment box's reply mark while the agent's question waits: "Replying to: <question>", which
// shows its question in Activity or hides for it; and the check of where the box's question placeholder
// fits on one line: beside the controls, or only on the text's own row.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { X } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { BotItemWaitingLine } from '../../../../../shared/bots/bot-item-question-answers'
import type { BotItemReplyMarkState } from '../../../../../shared/bots/bot-item-reply-target'
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
  /** The question's placeholder fits only with the text on its own row, so the box stacks. */
  crowded: boolean
}

/** The box's reply mark and placeholder for the waiting question, if any: the mark hides per question
 *  (`closed`, kept with the box's draft), and comes back with `show` (Type your answer); `reveal` shows its question in Activity; `glowing` is
 *  the composer's one glow. The question's placeholder stacks the box where it would cut beside the
 *  controls (`field` is the text's slot in their row), and gives way to the plain one where even its own
 *  row cuts it. */
export function useBotItemReplyMark(
  box: RefObject<HTMLDivElement | null>,
  field: RefObject<HTMLDivElement | null>,
  question: BotItemWaitingQuestion | null,
  scopeKey: string,
  closed: BotItemReplyMarkState,
  onReveal?: (eventId: string) => void
): BotItemReplyMark {
  const t = useTranslate()
  const long = question?.replies
    ? t('bots.items.comment.replyOrPick', 'Reply or pick an option')
    : t('bots.items.comment.replyTo', 'Reply to {{name}}…', { name: question?.asker ?? '' })
  const room = usePlaceholderRoom(box, field, long)
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
    quote: question && !closed.hidden ? question : null,
    hide: () => {
      closed.hide()
      focusText()
    },
    show: closed.show,
    reveal: () => {
      if (question) {
        onReveal?.(question.eventId)
      }
      focusText()
    },
    glowing,
    placeholder: question && room.ownRow ? long : t('bots.items.comment.add', 'Add a comment…'),
    crowded: question !== null && room.ownRow && !room.inline
  }
}

export function BotItemReplyingTo({ mark }: { mark: BotItemReplyMark }): React.JSX.Element | null {
  const t = useTranslate()
  if (!mark.quote) {
    return null
  }
  const question = mark.quote.line
  return (
    // Two sibling buttons: the mark shows the question, its × hides the mark. The dot and × sit on the
    // + and send buttons' centers, and the mark's edges on theirs.
    <div className="mb-1 flex h-[22px] max-w-full min-w-0 items-center gap-1 self-start rounded-md bg-foreground/[0.06] pr-[7px] text-xs text-muted-foreground">
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
            className="flex h-full min-w-0 cursor-pointer items-center gap-2 rounded-md pl-[13px] pr-1 outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring/50"
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
        onMouseDown={(event) => event.preventDefault()}
        onClick={mark.hide}
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

/** Whether `text` fits on one line of the editor, in its own font: beside the controls (`inline`), and on
 *  the text's own row (`ownRow`). The room beside the controls is the row less what is not text there,
 *  read while the text sits beside them and kept while it is stacked, so stacking never feeds back. Not
 *  read yet (the box opened stacked), it counts as fitting: the text tries the row once and is read there. */
function usePlaceholderRoom(
  box: RefObject<HTMLDivElement | null>,
  field: RefObject<HTMLDivElement | null>,
  text: string
): { inline: boolean; ownRow: boolean } {
  const [room, setRoom] = useState({ inline: true, ownRow: true })
  const besideText = useRef<number | null>(null)
  useLayoutEffect(() => {
    const frame = box.current
    const slot = field.current
    const row = slot?.parentElement
    if (!frame || !slot || !row) {
      return
    }
    // The editor mounts after the box, so it is found on each measure.
    const measure = (): void => {
      const node = frame.querySelector<HTMLElement>('[contenteditable]')
      if (!node) {
        return
      }
      const style = getComputedStyle(node)
      // Laid out in the editor's own font: canvas text runs a few percent narrower than the page's.
      const probe = document.createElement('span')
      probe.textContent = text
      probe.style.cssText =
        'position:absolute;visibility:hidden;white-space:pre;pointer-events:none;left:0;top:0'
      probe.style.fontFamily = style.fontFamily
      probe.style.fontSize = style.fontSize
      probe.style.fontWeight = style.fontWeight
      probe.style.fontStyle = style.fontStyle
      probe.style.letterSpacing = style.letterSpacing
      probe.style.fontFeatureSettings = style.fontFeatureSettings
      probe.style.fontVariationSettings = style.fontVariationSettings
      frame.append(probe)
      const needed = probe.getBoundingClientRect().width
      probe.remove()
      const textWidth =
        node.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight)
      const rowWidth = row.clientWidth
      const stacked = slot.offsetWidth >= rowWidth - 1
      if (!stacked) {
        besideText.current = rowWidth - textWidth
      }
      const inline = besideText.current === null || rowWidth - besideText.current >= needed
      // Stacked, the text's row is the whole row; beside the controls it would get that once stacked.
      const ownRow = (stacked ? textWidth : rowWidth) >= needed
      setRoom((last) =>
        last.inline === inline && last.ownRow === ownRow ? last : { inline, ownRow }
      )
    }
    const observer = new ResizeObserver(measure)
    observer.observe(frame)
    observer.observe(slot)
    measure()
    // A web font that lands later changes the text's width, not the box's.
    let live = true
    void document.fonts?.ready.then(() => live && measure())
    return () => {
      live = false
      observer.disconnect()
    }
  }, [box, field, text])
  return room
}

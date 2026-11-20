// A jump between a question and its answer in an item's Activity: only the Activity scrolls, the target
// lands mid-pane (below the sticky header), takes focus so Tab goes on from there, and a faint highlight
// fades off it without moving anything (held still, then gone, under reduced motion).
import { BOT_ITEM_COMMENT_ATTRIBUTE } from './BotItemCommentCard'
import { BOT_ITEM_QUESTION_LINE_ATTRIBUTE } from './BotItemQuestionStep'

/** A comment by its event id; with `line`, that line of its ask. */
export type BotItemJumpTarget = { eventId: string; line?: number }

const HIGHLIGHT = 'bot-item-jump-highlight'
const highlightEnds = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

function jumpTargetElement(list: HTMLElement, target: BotItemJumpTarget): HTMLElement | null {
  const line =
    target.line === undefined
      ? null
      : list.querySelector<HTMLElement>(
          `[${BOT_ITEM_QUESTION_LINE_ATTRIBUTE}="${CSS.escape(`${target.eventId}:${target.line}`)}"]`
        )
  return (
    line ??
    list.querySelector<HTMLElement>(
      `[${BOT_ITEM_COMMENT_ATTRIBUTE}="${CSS.escape(target.eventId)}"]`
    )
  )
}

export function jumpInBotItemActivity(list: HTMLElement | null, target: BotItemJumpTarget): void {
  const element = list ? jumpTargetElement(list, target) : null
  if (!element) {
    return
  }
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  element.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' })
  if (element.tabIndex < 0 && !element.hasAttribute('tabindex')) {
    element.tabIndex = -1
  }
  element.focus({ preventScroll: true })
  clearTimeout(highlightEnds.get(element))
  element.classList.remove(HIGHLIGHT)
  // Restarts the fade on a second jump to the same place.
  void element.offsetWidth
  element.classList.add(HIGHLIGHT)
  highlightEnds.set(
    element,
    setTimeout(() => element.classList.remove(HIGHLIGHT), still ? 1500 : 1800)
  )
}

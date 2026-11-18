// The open item in the list's place: the back row with its place in the list and ↓ ↑ to the next and
// previous item, over the item itself. Esc, and Back's chord (Cmd+[ / Alt+Left), go back from anywhere
// in it, and typing anywhere in it goes to the comment box. The row stays up across steps, so a
// clicked arrow keeps focus; offline only the item is off.
import { useEffect, useLayoutEffect, useRef } from 'react'
import { ArrowLeft, ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { keybindingMatchesAction } from '../../../../../shared/keybindings/matching'
import type { Bot } from '../../../../../shared/bot-types'
import { BotItemView } from './BotItemView'
import type { BotItemCommentBoxHandle } from './BotItemCommentBox'
import { typeIntoBotItemComment } from './bot-item-comment-typing'
import { BotItemsReadFailed } from './BotItemsReadFailed'
import type { BotItemWalkState } from './use-bot-item-walk'

export function BotItemPane({
  bot,
  uid,
  walk,
  offline,
  onBack
}: {
  bot: Bot
  uid: string
  walk: BotItemWalkState
  offline: boolean
  onBack: () => void
}): React.JSX.Element {
  return (
    <BotItemPaneFrame walk={walk} offline={offline} onBack={onBack}>
      {(comment) => (
        <BotItemView
          key={uid}
          bot={bot}
          uid={uid}
          takeFocus={takeFocus}
          commentRef={comment}
          onGone={walk.markGone}
        />
      )}
    </BotItemPaneFrame>
  )
}

/** The pane around an item: its keys, focus and back row. `children` gets the ref its comment box
 *  fills, so typing from anywhere in the pane (the arrows included) reaches the box. */
export function BotItemPaneFrame({
  walk,
  offline,
  onBack,
  children
}: {
  walk: BotItemWalkState
  offline: boolean
  onBack: () => void
  children: (comment: React.RefObject<BotItemCommentBoxHandle | null>) => React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const root = useRef<HTMLDivElement | null>(null)
  const comment = useRef<BotItemCommentBoxHandle | null>(null)
  useBotItemBackChord(root, onBack)
  // Open: focus here, so Esc works while the item reads; the item takes it once it shows.
  useEffect(() => {
    root.current?.focus({ preventScroll: true })
  }, [])
  return (
    <div
      ref={root}
      data-bot-item-pane=""
      tabIndex={-1}
      className="@container flex min-h-0 flex-1 flex-col pt-2 outline-none"
      onKeyDown={(event) => {
        // Menus and dialogs are portaled out of this DOM and take their own Escape first.
        if (event.key !== 'Escape') {
          typeIntoBotItemComment(event, root.current, comment.current)
          return
        }
        if (
          event.defaultPrevented ||
          isImeOwnedKeyboardEvent(event) ||
          !(event.target instanceof Node && event.currentTarget.contains(event.target))
        ) {
          return
        }
        event.preventDefault()
        onBack()
      }}
    >
      <div className="flex items-center gap-1 px-1.5 pb-1 text-xs text-muted-foreground">
        <Button variant="ghost" size="xs" onClick={onBack}>
          <ArrowLeft />
          {t('bots.items.tab', 'Items')}
        </Button>
        {walk.place ? (
          <BotItemStepper root={root} walk={walk} offline={offline} place={walk.place} />
        ) : null}
      </div>
      {walk.failed ? <BotItemsReadFailed onRetry={walk.retry} closedPage /> : null}
      {/* min-w-0: a fieldset is never narrower than its content, so one long unwrapped line widened the item. */}
      <fieldset disabled={offline} className="flex min-h-0 min-w-0 flex-1 flex-col">
        {children(comment)}
      </fieldset>
    </div>
  )
}

/** Nothing in the pane holds focus but the pane itself: the item takes it as it shows. */
function takeFocus(): boolean {
  const active = document.activeElement
  return active === null || active === document.body || active.hasAttribute('data-bot-item-pane')
}

function BotItemStepper({
  root,
  walk,
  offline,
  place
}: {
  root: React.RefObject<HTMLDivElement | null>
  walk: BotItemWalkState
  offline: boolean
  place: { index: number; total: number }
}): React.JSX.Element {
  const t = useTranslate()
  const nav = useRef<HTMLDivElement | null>(null)
  const hadFocus = useRef(false)
  // An arrow that goes disabled (an end, a pending read) drops focus; the pane keeps it instead.
  useLayoutEffect(() => {
    const active = document.activeElement
    const dropped =
      active === null ||
      active === document.body ||
      (active instanceof HTMLButtonElement && active.disabled && nav.current?.contains(active))
    if (hadFocus.current && dropped) {
      hadFocus.current = false
      root.current?.focus({ preventScroll: true })
    }
  })
  const arrow = (direction: 1 | -1): React.JSX.Element => {
    const label =
      direction === 1
        ? t('bots.items.view.next', 'Next item')
        : t('bots.items.view.previous', 'Previous item')
    const Icon = direction === 1 ? ChevronDown : ChevronUp
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            disabled={offline || !walk.canStep(direction)}
            onClick={() => walk.step(direction)}
          >
            <Icon />
          </Button>
        </TooltipTrigger>
        <TooltipContent sideOffset={4}>{label}</TooltipContent>
      </Tooltip>
    )
  }
  return (
    <div
      ref={nav}
      className="ml-auto flex items-center gap-0.5"
      onFocus={() => (hadFocus.current = true)}
      onBlur={(event) => {
        // Focus moved on to something; a drop to nothing (a disabled arrow) is caught above.
        if (event.relatedTarget !== null) {
          hadFocus.current = false
        }
      }}
    >
      <span className="px-1 tabular-nums">
        {t('bots.items.view.place', '{{index}} / {{total}}', place)}
      </span>
      {arrow(1)}
      {arrow(-1)}
    </div>
  )
}

/** Back's chord, through the app keyboard router: only from inside the pane, never a portaled layer. */
function useBotItemBackChord(
  root: React.RefObject<HTMLDivElement | null>,
  onBack: () => void
): void {
  const back = useLatestHandler(onBack)
  useEffect(() => {
    const platform = getShortcutPlatform()
    const onKeyDown = (event: KeyboardEvent): void => {
      const node = root.current
      if (
        event.defaultPrevented ||
        isImeOwnedKeyboardEvent(event) ||
        !node ||
        !(event.target instanceof Node) ||
        !node.contains(event.target) ||
        !keybindingMatchesAction(
          'botItem.back',
          event,
          platform,
          useAppStore.getState().keybindings
        )
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) {
        back()
      }
    }
    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
  }, [back, root])
}

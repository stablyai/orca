// The open item in the list's place: the back row over the item, and its place in the list with ↑ ↓ to the
// previous and next item in the comment box's tool row. Esc, and Back's chord (Cmd+[ / Alt+Left), go back
// from anywhere in it; ⌥⌘↑ / ⌥⌘↓ step, even while typing. Typing or dictating anywhere in it goes to the
// comment box. A step keeps focus on the arrow or the comment box it came from; offline only the item is off.
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useLatestHandler } from '@/lib/use-latest-handler'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import { BotItemView } from './BotItemView'
import type { BotItemCommentBoxHandle } from './BotItemCommentBox'
import { typeIntoBotItemComment } from './bot-item-comment-typing'
import { registerDictationInputOwner } from '../../dictation/dictation-insertion-target'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { BotItemsReadFailed } from './BotItemsReadFailed'
import { BotAvatar } from '../BotAvatar'
import type { BotItemWalkState } from './use-bot-item-walk'
import { BotItemStepper, BotItemSteppingContext, botItemStepArrow } from './BotItemStepper'
import { useBotItemChords, type BotItemStepOrigin } from './use-bot-item-chords'

const PENDING_NOTICE_DELAY_MS = 400

/** What the pane hands the item: the ref its comment box fills, the arrows for its tool row, and the
 *  call it makes once per mount when the item first shows. */
export type BotItemPaneSlots = {
  comment: React.RefObject<BotItemCommentBoxHandle | null>
  /** The back row's right end, where the item puts its status menu. */
  statusSlot: HTMLElement | null
  nav: React.ReactNode
  onShown: (item: BotItem) => void
  onLoading: () => (() => void) | undefined
}

export function BotItemPane({
  bot,
  uid,
  listed,
  walk,
  offline,
  onBack,
  named = false
}: {
  bot: Bot
  uid: string
  /** The item's list row: its header shows from it while the item reads. */
  listed?: BotItem
  walk: BotItemWalkState
  offline: boolean
  onBack: () => void
  /** Opened from a group's list: the back row names whose item it is. */
  named?: boolean
}): React.JSX.Element {
  return (
    <BotItemPaneFrame walk={walk} offline={offline} onBack={onBack} owner={named ? bot : null}>
      {(slots) => (
        <BotItemView
          key={uid}
          bot={bot}
          uid={uid}
          listed={listed}
          takeFocus={takeFocus}
          commentRef={slots.comment}
          statusSlot={slots.statusSlot}
          nav={slots.nav}
          onShown={slots.onShown}
          onLoading={slots.onLoading}
          onGone={walk.markGone}
        />
      )}
    </BotItemPaneFrame>
  )
}

/** The pane around an item: its keys, focus and back row. */
export function BotItemPaneFrame({
  walk,
  offline,
  onBack,
  owner = null,
  children
}: {
  walk: BotItemWalkState
  offline: boolean
  onBack: () => void
  /** Whose item it is, named after Back. */
  owner?: Bot | null
  children: (slots: BotItemPaneSlots) => React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const root = useRef<HTMLDivElement | null>(null)
  const comment = useRef<BotItemCommentBoxHandle | null>(null)
  const announcer = useRef<BotItemAnnouncerHandle | null>(null)
  const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null)
  const onLoading = useLatestHandler(() => announcer.current?.loading())
  // The committed item and place, read after a step's flush and by the item's first-show call.
  const shown = useRef({ uid: walk.uid, place: walk.place, opening: true })
  useLayoutEffect(() => {
    const now = shown.current
    // Leaving the opened item ends its (silent) opening, even if it never showed.
    shown.current = {
      uid: walk.uid,
      place: walk.place,
      opening: now.opening && now.uid === walk.uid
    }
  })
  const step = useLatestHandler((direction: 1 | -1, from: BotItemStepOrigin): void => {
    const place = shown.current.place
    if (offline || !place) {
      return
    }
    if (direction === 1 ? place.index === place.total : place.index === 1) {
      announcer.current?.say(
        direction === 1
          ? t('bots.items.view.lastItem', 'Last item')
          : t('bots.items.view.firstItem', 'First item')
      )
      return
    }
    if (walk.pending) {
      return
    }
    const before = shown.current.uid
    // An arrow pressed while focus stays in the text: it takes focus now, so the next item's box opens
    // with the arrows in view for focus to come back to.
    if (from === 'previous' || from === 'next') {
      botItemStepArrow(root.current, from)?.focus({ preventScroll: true })
    }
    flushSync(() => walk.step(direction))
    if (shown.current.uid !== before) {
      focusAfterStep(root.current, comment.current, from)
    }
  })
  const onShown = useLatestHandler((item: BotItem): void => {
    const now = shown.current
    if (now.opening) {
      // The open itself, shown now or late: not announced.
      if (item.uid === now.uid) {
        shown.current = { ...now, opening: false }
      }
      return
    }
    if (item.uid === now.uid && now.place) {
      announcer.current?.say(
        t('bots.items.view.shown', 'Item {{index}} of {{total}}: {{title}}', {
          ...now.place,
          title: item.title
        })
      )
    }
  })
  const loading = useSlowPending(walk.pending)
  useBotItemChords(root, { back: onBack, step })
  // Open: focus here, so Esc works while the item reads; the item takes it once it shows.
  useEffect(() => {
    root.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    const pane = root.current
    return pane
      ? registerDictationInputOwner(pane, { focusInput: () => comment.current?.focus() })
      : undefined
  }, [])
  const nav = walk.place ? (
    <BotItemStepper
      pane={root}
      place={walk.place}
      loading={loading}
      offline={offline}
      canStep={walk.canStep}
      onStep={step}
    />
  ) : null
  return (
    <div
      ref={root}
      data-bot-item-pane=""
      tabIndex={-1}
      className="@container/item-pane flex min-h-0 flex-1 flex-col pt-2 outline-none"
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
      <div className="flex min-w-0 items-center gap-1 px-2 pt-2 pb-1 text-xs text-muted-foreground">
        <Button variant="ghost" size="xs" data-bot-item-back="" onClick={onBack}>
          <ArrowLeft />
          {t('bots.items.tab', 'Home')}
        </Button>
        {owner ? (
          <span className="flex min-w-0 items-center gap-1.5 px-1 text-foreground">
            <BotAvatar bot={owner} className="size-4 shrink-0 rounded-full text-[9px]" />
            <span className="min-w-0 truncate">{owner.name}</span>
          </span>
        ) : null}
        {/* Outside the item's fieldset, so offline is set here too. */}
        <fieldset
          ref={setStatusSlot}
          disabled={offline}
          className="ml-auto flex min-w-0 shrink-0 items-center"
        />
      </div>
      {walk.failed ? <BotItemsReadFailed onRetry={walk.retry} closedPage /> : null}
      {/* min-w-0: a fieldset is never narrower than its content, so one long unwrapped line widened the item. */}
      <fieldset disabled={offline} className="flex min-h-0 min-w-0 flex-1 flex-col">
        <BotItemSteppingContext value={walk.pending}>
          {children({ comment, statusSlot, nav, onShown, onLoading })}
        </BotItemSteppingContext>
      </fieldset>
      <BotItemAnnouncer ref={announcer} />
    </div>
  )
}

/** Nothing in the pane holds focus but the pane itself: the item takes it as it shows. */
function takeFocus(): boolean {
  const active = document.activeElement
  return active === null || active === document.body || active.hasAttribute('data-bot-item-pane')
}

/** After a step that changed the item: focus the arrow or comment box it came from, else the pane. */
function focusAfterStep(
  pane: HTMLDivElement | null,
  comment: BotItemCommentBoxHandle | null,
  from: BotItemStepOrigin
): void {
  if (from === 'editor' && comment) {
    comment.focusEnd()
    return
  }
  const arrow = from === 'editor' || from === null ? null : botItemStepArrow(pane, from)
  if (arrow && !arrow.disabled) {
    arrow.focus()
    return
  }
  const active = document.activeElement
  // Only focus the step left on nothing; a control elsewhere keeps it.
  if (from !== null || active === null || active === document.body) {
    pane?.focus({ preventScroll: true })
  }
}

/** True once `pending` has lasted a moment: shorter reads show nothing, so nothing flickers. */
function useSlowPending(pending: boolean): boolean {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!pending) {
      return
    }
    const timer = window.setTimeout(() => setSlow(true), PENDING_NOTICE_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
      setSlow(false)
    }
  }, [pending])
  return pending && slow
}

type BotItemAnnouncerHandle = { say: (text: string) => void; loading: () => () => void }

/** The pane's screen-reader line. A leaf, so speaking re-renders only it. */
function BotItemAnnouncer({ ref }: { ref: React.Ref<BotItemAnnouncerHandle> }): React.JSX.Element {
  const t = useTranslate()
  const [said, setSaid] = useState('')
  const cancelLoading = useRef<(() => void) | null>(null)
  useEffect(() => () => cancelLoading.current?.(), [])
  useImperativeHandle(ref, () => ({
    // The same words again still change the text, so they're read again.
    say: (text) => {
      cancelLoading.current?.()
      setSaid((previous) => (previous === text ? `${text} ` : text))
    },
    loading: () => {
      cancelLoading.current?.()
      setSaid('')
      let announced = false
      const stop = (): void => {
        window.clearTimeout(timer)
        if (cancelLoading.current === stop) {
          cancelLoading.current = null
          if (announced) {
            setSaid('')
          }
        }
      }
      const timer = window.setTimeout(() => {
        if (cancelLoading.current === stop) {
          announced = true
          setSaid(t('bots.items.view.loading', 'Loading item…'))
        }
      }, PENDING_NOTICE_DELAY_MS)
      cancelLoading.current = stop
      return stop
    }
  }))
  return (
    <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {said}
    </span>
  )
}

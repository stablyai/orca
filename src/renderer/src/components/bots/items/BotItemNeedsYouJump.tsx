// The item view's one jump pill, the chat's own: while the item needs the owner and the entry that asked
// is off screen it reads Needs you and points there; a click reads the pages before it if needed, scrolls
// it in under the header with a brief ring and puts the cursor in the comment box. Otherwise it is the
// chat's Jump to latest; with the question on screen, no pill.
import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatJumpToLatest } from '../../native-chat/viewport/scroll/NativeChatJumpToLatest'
import type { BotItemNeedsYouMark } from './BotItemNeedsYouMark'
import type { BotItemCommentBoxHandle } from './BotItemCommentBox'
import { createBotItemNeedsYouWatch, type BotItemNeedsYouWatch } from './bot-item-needs-you-watch'

export type BotItemNeedsYouJump = {
  /** For the Activity: the entry to mark, while the pill can lead there. */
  mark: BotItemNeedsYouMark | undefined
  /** Over the Activity, above the comment box. */
  pill: React.ReactNode
  /** For the comment box after a jump: the entry it answers, read with it. */
  describedBy: string | undefined
}

export function useBotItemNeedsYouJump({
  eligible,
  activityShown,
  loadingTarget,
  scrollRef,
  revealRow,
  comment,
  showLatest,
  jumpToLatest
}: {
  /** Needs you and no answer is on its way. */
  eligible: boolean
  activityShown: boolean
  /** The item view is already reading earlier pages to find the question. */
  loadingTarget: boolean
  scrollRef: React.RefObject<HTMLDivElement | null>
  revealRow: (row: HTMLElement, behavior: ScrollBehavior) => void
  comment: React.RefObject<BotItemCommentBoxHandle | null>
  /** The chat's own rule for Jump to latest: not following and away from the end. */
  showLatest: boolean
  jumpToLatest: () => void
}): BotItemNeedsYouJump {
  const [watch] = useState(createBotItemNeedsYouWatch)
  const id = useId()
  const { opened, jumped, pending } = useSyncExternalStore(watch.subscribe, watch.jump)
  const reveal = (node: HTMLElement): void => {
    watch.revealed()
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // Lands at the top of the Activity's scroller, just under the fixed header.
    revealRow(node, still ? 'auto' : 'smooth')
    // Keyframes take a color, not a variable: the theme's amber, read on the click.
    const amber = getComputedStyle(node).getPropertyValue('--agent-question').trim()
    const ring = `0 0 0 2px ${amber || 'currentColor'}`
    node.animate?.(
      [
        { boxShadow: ring },
        { boxShadow: ring, offset: 0.4 },
        { boxShadow: '0 0 0 2px transparent' }
      ],
      { duration: 1400, easing: 'ease' }
    )
    if (comment.current) {
      comment.current.focus()
    } else {
      // An earlier page can attach its Activity row before the composer handle returns.
      const landed = watch.jump()
      requestAnimationFrame(() => {
        if (node.isConnected && watch.node() === node && watch.jump() === landed) {
          comment.current?.focus()
        }
      })
    }
  }
  // A pending jump goes on from the entry's ref, as it draws; it uses this render's comment box.
  useEffect(() => {
    watch.setReveal(reveal)
  })
  useEffect(() => {
    watch.setRoot(scrollRef.current)
    return () => {
      watch.setRoot(null)
      watch.stop()
    }
  }, [watch, scrollRef])
  useEffect(() => {
    if (!eligible) {
      watch.forget()
    }
  }, [eligible, watch])

  useEffect(() => {
    if (!loadingTarget) {
      watch.cancel()
    }
  }, [loadingTarget, watch])

  // The owner scrolling or typing meanwhile takes over: no late jump pulls the page away.
  useEffect(() => {
    const root = scrollRef.current
    if (!pending) {
      return
    }
    const cancel = (): void => watch.cancel()
    root?.addEventListener('wheel', cancel, { passive: true })
    root?.addEventListener('touchmove', cancel, { passive: true })
    root?.addEventListener('pointerdown', cancel)
    window.addEventListener('keydown', cancel, true)
    return () => {
      root?.removeEventListener('wheel', cancel)
      root?.removeEventListener('touchmove', cancel)
      root?.removeEventListener('pointerdown', cancel)
      window.removeEventListener('keydown', cancel, true)
    }
  }, [pending, scrollRef, watch])

  const jump = (): void => {
    const node = watch.node()
    if (node) {
      reveal(node)
    } else if (loadingTarget) {
      watch.wait()
    }
  }

  return {
    mark: eligible ? { setNode: watch.setNode, opened, id } : undefined,
    pill: (
      <BotItemJumpPill
        watch={watch}
        waiting={eligible && activityShown}
        loadingTarget={loadingTarget}
        showLatest={showLatest}
        onNeedsYou={jump}
        onLatest={jumpToLatest}
      />
    ),
    describedBy: eligible && jumped ? id : undefined
  }
}

type BotItemJumpPillState = { shown: boolean; needsYou: boolean; direction: 'up' | 'down' }

/** Its own component, so the entry crossing the view's edge re-renders only the pill. */
function BotItemJumpPill({
  watch,
  waiting,
  loadingTarget,
  showLatest,
  onNeedsYou,
  onLatest
}: {
  watch: BotItemNeedsYouWatch
  waiting: boolean
  loadingTarget: boolean
  showLatest: boolean
  onNeedsYou: () => void
  onLatest: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const watched = useSyncExternalStore(watch.subscribe, watch.place)
  // Not drawn yet: its page is still being read, before the ones shown.
  const place = watched === 'undrawn' && loadingTarget ? 'above' : watched
  const next: BotItemJumpPillState =
    waiting && (place === 'above' || place === 'below')
      ? { shown: true, needsYou: true, direction: place === 'above' ? 'up' : 'down' }
      : waiting && place !== 'undrawn'
        ? { shown: false, needsYou: true, direction: 'down' }
        : { shown: showLatest, needsYou: false, direction: 'down' }
  // A hidden pill keeps its last label and arrow while it fades out.
  const [last, setLast] = useState(next)
  if (next.shown && (next.needsYou !== last.needsYou || next.direction !== last.direction)) {
    setLast(next)
  }
  const look = next.shown ? next : last
  return (
    <NativeChatJumpToLatest
      visible={next.shown}
      onJump={look.needsYou ? onNeedsYou : onLatest}
      label={look.needsYou ? t('bots.items.status.needsYou', 'Needs you') : undefined}
      direction={look.direction}
      needsYou={look.needsYou}
    />
  )
}

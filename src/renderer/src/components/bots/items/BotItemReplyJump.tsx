// The header's Reply while the item needs the owner: shown only when the entry that asked is off screen,
// its arrow pointing there. A click reads the pages before it if needed, scrolls it in under the header
// with a brief ring and puts the cursor in the comment box.
import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import { ArrowDown, ArrowUp, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { BotItemNeedsYouMark } from './BotItemNeedsYouMark'
import type { BotItemCommentBoxHandle } from './BotItemCommentBox'
import {
  createBotItemNeedsYouWatch,
  type BotItemNeedsYouPlace,
  type BotItemNeedsYouWatch
} from './bot-item-needs-you-watch'

export type BotItemNeedsYouJump = {
  /** For the Activity: the entry to mark, while Reply can lead there. */
  mark: BotItemNeedsYouMark | undefined
  /** For the header's status row. */
  reply: React.ReactNode
  /** The header's height, which the observer leaves out of the scroller's view. */
  setHeaderHeight: (height: number) => void
  /** For the comment box after a jump: the entry it answers, read with it. */
  describedBy: string | undefined
  /** Reply points down (or waits on a page): Jump to latest would be a second way down. */
  pointsDown: boolean
}

export function useBotItemNeedsYouJump({
  eligible,
  activityShown,
  loadingTarget,
  scrollRef,
  comment
}: {
  /** Needs you and no answer is on its way. */
  eligible: boolean
  activityShown: boolean
  /** The item view is already reading earlier pages to find the question. */
  loadingTarget: boolean
  scrollRef: React.RefObject<HTMLDivElement | null>
  comment: React.RefObject<BotItemCommentBoxHandle | null>
}): BotItemNeedsYouJump {
  const [watch] = useState(createBotItemNeedsYouWatch)
  const id = useId()
  const { opened, jumped, pending } = useSyncExternalStore(watch.subscribe, watch.jump)
  const below = useSyncExternalStore(watch.subscribe, () => watch.place() === 'below')
  const reveal = (node: HTMLElement): void => {
    watch.revealed()
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // The scroller's scroll padding is the header's height, so it lands just under the header.
    node.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' })
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
    comment.current?.focus()
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
    reply:
      eligible && activityShown ? (
        <BotItemReplyButton
          watch={watch}
          fallback={loadingTarget ? 'above' : null}
          busy={pending}
          onJump={jump}
        />
      ) : null,
    setHeaderHeight: watch.setTop,
    describedBy: eligible && jumped ? id : undefined,
    pointsDown: eligible && activityShown && (below || pending)
  }
}

function BotItemReplyButton({
  watch,
  fallback,
  busy,
  onJump
}: {
  watch: BotItemNeedsYouWatch
  /** Where the entry is while it isn't drawn (its page not read yet). */
  fallback: BotItemNeedsYouPlace
  busy: boolean
  onJump: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const watched = useSyncExternalStore(watch.subscribe, watch.place)
  const place = watched === 'undrawn' ? fallback : watched
  if (place === null || place === 'visible' || place === 'undrawn') {
    return null
  }
  const Arrow = place === 'above' ? ArrowUp : ArrowDown
  return (
    <Button
      variant="needs-you"
      size="xs"
      aria-busy={busy || undefined}
      aria-label={
        place === 'above'
          ? t('bots.items.view.replyAbove', 'Reply, above')
          : t('bots.items.view.replyBelow', 'Reply, below')
      }
      onClick={onJump}
    >
      {t('bots.items.view.reply', 'Reply')}
      {busy ? (
        <LoaderCircle aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />
      ) : (
        <Arrow aria-hidden className="size-3" />
      )}
    </Button>
  )
}

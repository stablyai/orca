import { useMemo, useSyncExternalStore, type RefObject } from 'react'
import {
  getFloatingTerminalTriggerKeepClearRects,
  subscribeToFloatingTerminalTriggerKeepClearRects
} from '@/components/floating-terminal/trigger/floating-terminal-trigger-keep-clear'
import {
  TITLEBAR_SAFE_TOP,
  type FloatingTerminalTriggerKeepClearRect
} from '@/components/floating-terminal/trigger/floating-terminal-trigger-position'
import { NOTIFICATION_CARD_STACK_BOTTOM } from '@/lib/notifications/notification-card-stack-height'

export function getToasterBottomLift(
  rects: readonly FloatingTerminalTriggerKeepClearRect[],
  viewportHeight: number,
  toasterBase: number,
  column: { left: number; right: number },
  gap: number,
  toastHeight: number
): number {
  let toastBottom = toasterBase
  for (const rect of rects) {
    if (rect.paneBottom >= toasterBase && rect.right > column.left && rect.left < column.right) {
      toastBottom = Math.min(toastBottom, rect.top - gap)
    }
  }
  return toastBottom < toasterBase && toastBottom - toastHeight >= TITLEBAR_SAFE_TOP
    ? viewportHeight - toastBottom
    : 0
}

const BOTTOM_RIGHT_LIST =
  ':scope > [data-sonner-toaster][data-y-position="bottom"][data-x-position="right"]'

function readBottomLift(list: HTMLElement, front: HTMLElement): number {
  const rects = getFloatingTerminalTriggerKeepClearRects()
  if (rects.length === 0) {
    return 0
  }
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
  const { innerHeight } = window
  const left = list.getBoundingClientRect().left + front.offsetLeft
  const width = front.offsetWidth
  // Sonner can animate a fixed height while the toast content has already grown.
  const height = Math.max(front.getBoundingClientRect().height, front.scrollHeight)
  if (width <= 0 || height <= 0) {
    return 0
  }
  // Use the status-bar offset to find the bottom pane, even if cards push the toast up.
  const toasterBase = innerHeight - Number.parseFloat(NOTIFICATION_CARD_STACK_BOTTOM) * rem
  return getToasterBottomLift(
    rects,
    innerHeight,
    toasterBase,
    { left, right: left + width },
    0.5 * rem,
    height
  )
}

function observeBottomLift(section: HTMLElement, publish: (lift: number) => void): () => void {
  let list: HTMLElement | null = null
  let front: HTMLElement | null | undefined
  let resized: ResizeObserver | undefined
  let stopTracking: (() => void) | undefined
  const recompute = (): void => publish(list && front ? readBottomLift(list, front) : 0)
  const changed = new MutationObserver(syncFrontToast)

  function syncFrontToast(): void {
    const nextList = section.querySelector<HTMLElement>(BOTTOM_RIGHT_LIST)
    if (list !== nextList) {
      list = nextList
      changed.disconnect()
      changed.observe(section, { childList: true })
      if (list) {
        changed.observe(list, { childList: true })
      }
    }
    const firstChild = list?.firstElementChild
    const nextFront = firstChild instanceof HTMLElement ? firstChild : null
    if (front === nextFront) {
      return
    }
    front = nextFront
    resized?.disconnect()
    if (front) {
      resized ??= new ResizeObserver(recompute)
      resized.observe(front, { box: 'border-box' })
      const content = front.querySelector(':scope > [data-content]')
      if (content) {
        resized.observe(content)
      }
      if (!stopTracking) {
        const unsubscribe = subscribeToFloatingTerminalTriggerKeepClearRects(recompute)
        window.addEventListener('resize', recompute)
        stopTracking = () => {
          unsubscribe()
          window.removeEventListener('resize', recompute)
        }
      }
    } else {
      stopTracking?.()
      stopTracking = undefined
    }
    recompute()
  }

  changed.observe(section, { childList: true })
  syncFrontToast()
  return () => {
    changed.disconnect()
    resized?.disconnect()
    stopTracking?.()
  }
}

function createBottomLiftStore(sectionRef: RefObject<HTMLElement | null>) {
  let lift = 0
  return {
    getSnapshot: () => lift,
    subscribe: (onChange: () => void) => {
      const section = sectionRef.current
      if (!section) {
        return () => {}
      }
      return observeBottomLift(section, (nextLift) => {
        if (lift !== nextLift) {
          lift = nextLift
          onChange()
        }
      })
    }
  }
}

const noLift = (): number => 0

export function useToasterBottomLift(sectionRef: RefObject<HTMLElement | null>): number {
  const store = useMemo(() => createBottomLiftStore(sectionRef), [sectionRef])
  return useSyncExternalStore(store.subscribe, store.getSnapshot, noLift)
}

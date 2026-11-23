import { useEffect, useRef, type RefObject, type UIEvent, type KeyboardEvent } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'

export function useWorkerDockScroll({
  small,
  viewport,
  virtual,
  items,
  onAnchorChange,
  measure,
  hold,
  setBrowsing,
  scrollTo
}: {
  small: boolean
  viewport: RefObject<HTMLDivElement | null>
  virtual: Virtualizer<HTMLDivElement, HTMLDivElement>
  items: readonly { id: string }[]
  onAnchorChange: (anchor: { id: string; offset: number; index: number }) => void
  measure: () => void
  hold: () => void
  setBrowsing: (value: boolean) => void
  scrollTo: (index: number) => void
}) {
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(settle.current), [])
  return {
    onScroll: (event: UIEvent<HTMLDivElement>) => {
      const first = small
        ? [...event.currentTarget.querySelectorAll<HTMLElement>('[data-index]')]
            .map((node) => ({
              index: Number(node.dataset.index),
              start: node.offsetTop,
              end: node.offsetTop + node.offsetHeight
            }))
            .find((item) => item.end > event.currentTarget.scrollTop)
        : virtual.getVirtualItems().find((item) => item.end > (viewport.current?.scrollTop ?? 0))
      if (first) {
        onAnchorChange({
          id: items[first.index].id,
          offset: (viewport.current?.scrollTop ?? 0) - first.start,
          index: first.index
        })
      }
      if ((viewport.current?.scrollTop ?? 0) > 0) {
        setBrowsing(true)
        hold()
      }
      measure()
      clearTimeout(settle.current)
      settle.current = setTimeout(() => {
        const element = viewport.current
        if (!element) {
          return
        }
        const top = element.scrollTop
        const candidates = small
          ? [...element.querySelectorAll<HTMLElement>('[data-index]')].map((node) => node.offsetTop)
          : virtual.getVirtualItems().map((item) => item.start)
        const nearest = candidates.reduce(
          (best, next) => (Math.abs(next - top) < Math.abs(best - top) ? next : best),
          top === 0 ? 0 : (candidates[0] ?? 0)
        )
        if (Math.abs(top - nearest) > 1) {
          element.scrollTop = nearest
        }
        measure()
      }, 100)
    },
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) {
        return
      }
      const first = small
        ? Number(
            [...event.currentTarget.querySelectorAll<HTMLElement>('[data-index]')].find(
              (node) => node.offsetTop + node.offsetHeight > event.currentTarget.scrollTop
            )?.dataset.index ?? 0
          )
        : (virtual.getVirtualItems().find((item) => item.end > event.currentTarget.scrollTop)
            ?.index ?? 0)
      const step =
        event.key === 'ArrowDown'
          ? first + 1
          : event.key === 'ArrowUp'
            ? first - 1
            : event.key === 'PageDown'
              ? first + 3
              : event.key === 'PageUp'
                ? first - 3
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? items.length - 1
                    : null
      if (step !== null) {
        event.preventDefault()
        scrollTo(step)
      }
    }
  }
}

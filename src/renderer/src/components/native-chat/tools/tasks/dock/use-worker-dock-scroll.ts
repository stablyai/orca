import type { RefObject, UIEvent, KeyboardEvent } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'

/** The open roster's own scrolling: native wheel, trackpad and touch move it freely (no snapping
 *  back to a row edge), and arrow/Page/Home/End step through rows while the list has focus. */
export function useWorkerDockScroll({
  small,
  viewport,
  virtual,
  items,
  onAnchorChange,
  onScrolled,
  scrollTo
}: {
  small: boolean
  viewport: RefObject<HTMLDivElement | null>
  virtual: Virtualizer<HTMLDivElement, HTMLDivElement>
  items: readonly { id: string }[]
  onAnchorChange: (anchor: { id: string; offset: number; index: number }) => void
  onScrolled: () => void
  scrollTo: (index: number) => void
}) {
  const firstVisible = (element: HTMLElement) =>
    small
      ? [...element.querySelectorAll<HTMLElement>('[data-index]')]
          .map((node) => ({
            index: Number(node.dataset.index),
            start: node.offsetTop,
            end: node.offsetTop + node.offsetHeight
          }))
          .find((item) => item.end > element.scrollTop)
      : virtual.getVirtualItems().find((item) => item.end > element.scrollTop)
  return {
    onScroll: (event: UIEvent<HTMLDivElement>) => {
      const element = event.currentTarget
      const first = firstVisible(element)
      if (first && items[first.index]) {
        onAnchorChange({
          id: items[first.index].id,
          offset: element.scrollTop - first.start,
          index: first.index
        })
      }
      onScrolled()
    },
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget || !viewport.current) {
        return
      }
      const first = firstVisible(event.currentTarget)?.index ?? 0
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

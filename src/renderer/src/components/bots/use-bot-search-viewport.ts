import { useEffect, type RefObject } from 'react'

export function useBotSearchViewport(
  inputRef: RefObject<HTMLInputElement | null>,
  hasQuery: boolean
): void {
  useEffect(() => {
    const input = inputRef.current
    const split = input?.closest<HTMLElement>('[data-sidebar-bots-split]')
    const viewport = split?.closest<HTMLElement>('[data-sidebar-content-viewport]')
    if (!input || !split || !viewport) {
      return
    }

    let following = true
    let revealedScrollTop = viewport.scrollTop
    let allocation = viewport.getBoundingClientRect()
    const reveal = (): void => {
      const box = split.getBoundingClientRect()
      const handle = split
        .querySelector('[data-sidebar-bots-resize-handle]')
        ?.getBoundingClientRect()
      const style = getComputedStyle(split)
      const zoom = split.currentCSSZoom || 1
      const required =
        box.height / zoom +
        Math.max(
          Number.parseFloat(style.scrollMarginTop) || 0,
          (box.top - (handle?.top ?? box.top)) / zoom
        ) +
        Math.max(
          Number.parseFloat(style.scrollMarginBottom) || 0,
          ((handle?.bottom ?? box.bottom) - box.bottom) / zoom
        )
      const viewportBox = viewport.getBoundingClientRect()
      const available = viewport.clientHeight
      const fieldOnly = required > available
      if (split.hasAttribute('data-bot-search-field-only') !== fieldOnly) {
        split.toggleAttribute('data-bot-search-field-only', fieldOnly)
      }
      if (!following || input.ownerDocument.activeElement !== input) {
        return
      }
      const target = fieldOnly ? input.parentElement : split
      target?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
      revealedScrollTop = viewport.scrollTop
      allocation = viewportBox
    }
    const onFocus = (): void => {
      following = true
      reveal()
    }
    const onScroll = (): void => {
      // Explicit outer navigation takes over until the user focuses search again.
      if (viewport.scrollTop === revealedScrollTop) {
        return
      }
      const box = viewport.getBoundingClientRect()
      if (box.height === allocation.height && box.width === allocation.width) {
        following = false
      }
    }
    const observer = new ResizeObserver(reveal)
    observer.observe(viewport)
    observer.observe(split)
    if (split.previousElementSibling) {
      observer.observe(split.previousElementSibling)
    }
    input.addEventListener('focus', onFocus)
    viewport.addEventListener('scroll', onScroll, { passive: true })
    reveal()
    return () => {
      observer.disconnect()
      split.removeAttribute('data-bot-search-field-only')
      input.removeEventListener('focus', onFocus)
      viewport.removeEventListener('scroll', onScroll)
    }
  }, [inputRef])

  useEffect(() => {
    const input = inputRef.current
    const panel = input?.closest('[data-bot-sidebar-search]')
    const field = input?.parentElement
    const scroller = hasQuery
      ? panel?.querySelector<HTMLElement>('.bot-sidebar-scrollbar')
      : panel?.parentElement?.querySelector<HTMLElement>('[data-bot-sidebar-list]')
    if (!field || !scroller) {
      return
    }
    const update = (): void => {
      const scrolled = scroller.scrollTop > 0
      if (field.hasAttribute('data-bot-search-scrolled') !== scrolled) {
        field.toggleAttribute('data-bot-search-scrolled', scrolled)
      }
    }
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', update)
      field.removeAttribute('data-bot-search-scrolled')
    }
  }, [inputRef, hasQuery])
}

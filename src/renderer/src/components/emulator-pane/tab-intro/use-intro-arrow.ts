import { useLayoutEffect } from 'react'
import { introArrowInset, revealScrollDelta } from './intro-arrow-geometry'

/** The create row's edge-fade width (main.css .terminal-tab-strip--fade-*). */
const ROW_FADE_PX = 24

export type IntroArrowAnchor = {
  /** The create row's horizontally scrolling icon strip. */
  scroller: HTMLElement | null
  /** Changes when the icons are reordered, shown or hidden. */
  order: string
}

/** Points the callout's arrow at an icon in the create row, revealing the icon first. */
export function useIntroArrow(
  callout: HTMLElement | null,
  anchor: IntroArrowAnchor,
  itemId: string
): void {
  const { scroller, order } = anchor
  useLayoutEffect(() => {
    if (!callout || !scroller) {
      return
    }
    const icon = scroller.querySelector<HTMLElement>(
      `[data-create-row-item="${CSS.escape(itemId)}"]`
    )
    if (!icon) {
      return
    }
    const scaleOf = (): number => {
      const width = callout.getBoundingClientRect().width
      return callout.offsetWidth > 0 && width > 0 ? width / callout.offsetWidth : 1
    }
    const delta = revealScrollDelta({
      item: icon.getBoundingClientRect(),
      view: scroller.getBoundingClientRect(),
      margin: ROW_FADE_PX,
      scale: scaleOf()
    })
    if (delta !== 0) {
      scroller.scrollBy({ left: delta, behavior: 'instant' })
    }
    const measure = (): void => {
      if (callout.offsetWidth === 0) {
        return
      }
      const box = callout.getBoundingClientRect()
      const iconBox = icon.getBoundingClientRect()
      const style = getComputedStyle(callout)
      const { inset, visible } = introArrowInset({
        callout: box,
        borderStart: Number.parseFloat(style.borderInlineStartWidth) || 0,
        width: callout.clientWidth,
        iconCenter: (iconBox.left + iconBox.right) / 2,
        view: scroller.getBoundingClientRect(),
        scale: box.width / callout.offsetWidth,
        rtl: style.direction === 'rtl'
      })
      callout.style.setProperty('--intro-arrow-x', `${inset}px`)
      callout.style.setProperty('--intro-arrow-display', visible ? 'block' : 'none')
    }
    measure()
    let frame: number | null = null
    const schedule = (): void => {
      if (frame === null) {
        frame = requestAnimationFrame(() => {
          frame = null
          measure()
        })
      }
    }
    const resize = new ResizeObserver(schedule)
    resize.observe(callout)
    resize.observe(scroller)
    scroller.addEventListener('scroll', schedule, { passive: true })
    return () => {
      resize.disconnect()
      scroller.removeEventListener('scroll', schedule)
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
    }
    // `order` re-runs this after customizing moves the icon.
  }, [callout, scroller, order, itemId])
}

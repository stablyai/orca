import { useEffect, type RefObject } from 'react'
import {
  BROWSER_ANNOTATE_SURFACE_ATTRIBUTE,
  registerAnnotateKeyPage
} from './annotate-esc-ownership'

/**
 * Gives a page's annotate keys an owner: its viewport surface (and Draw's portal target) carries its id, so keys
 * from Draw's canvas, the comment card or the notes list resolve to it, and the page is registered while its mode is on.
 */
export function useAnnotateKeyPage({
  pageId,
  containerRef,
  markupPortalContainer,
  modeOn
}: {
  pageId: string
  containerRef: RefObject<HTMLDivElement | null>
  markupPortalContainer?: HTMLDivElement | null
  modeOn: boolean
}): void {
  useEffect(() => {
    if (!pageId) {
      return
    }
    const surfaces = [containerRef.current, markupPortalContainer ?? null].filter(
      (element): element is HTMLDivElement => element !== null
    )
    for (const surface of surfaces) {
      surface.setAttribute(BROWSER_ANNOTATE_SURFACE_ATTRIBUTE, pageId)
    }
    return () => {
      for (const surface of surfaces) {
        if (surface.getAttribute(BROWSER_ANNOTATE_SURFACE_ATTRIBUTE) === pageId) {
          surface.removeAttribute(BROWSER_ANNOTATE_SURFACE_ATTRIBUTE)
        }
      }
    }
  }, [containerRef, markupPortalContainer, pageId])

  useEffect(() => {
    if (!modeOn || !pageId) {
      return
    }
    return registerAnnotateKeyPage(pageId, () => containerRef.current)
  }, [containerRef, modeOn, pageId])
}

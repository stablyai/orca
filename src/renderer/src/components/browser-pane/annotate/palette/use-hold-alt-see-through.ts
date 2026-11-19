import { useEffect, useState } from 'react'

const SEE_THROUGH_ATTRIBUTE = 'data-browser-annotate-see-through'

/**
 * While Alt is held, the palette fades and lets clicks through, so the element under it can be picked.
 * Why both sources: the renderer sees Alt when it has focus (Draw, the palette itself); a focused page keeps its
 * keys, so main mirrors Alt's edges from the page while a pick runs.
 */
export function useHoldAltSeeThrough(pageId: string | null): boolean {
  const [held, setHeld] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Alt' && !event.repeat) {
        setHeld(true)
      }
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === 'Alt') {
        setHeld(false)
      }
    }
    // Losing the window mid-hold never delivers the keyup.
    const release = (): void => setHeld(false)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', release)
    const unsubscribe = pageId
      ? window.api.browser.onGrabActionShortcut(({ browserPageId, key }) => {
          if (browserPageId !== pageId) {
            return
          }
          if (key === 'alt-down') {
            setHeld(true)
          } else if (key === 'alt-up') {
            setHeld(false)
          }
        })
      : null
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', release)
      unsubscribe?.()
    }
  }, [pageId])

  // Tooltips render in a portal outside the palette; a root flag lets CSS hide them while the palette is faded.
  useEffect(() => {
    if (!held) {
      return
    }
    const root = document.documentElement
    root.setAttribute(SEE_THROUGH_ATTRIBUTE, '')
    return () => root.removeAttribute(SEE_THROUGH_ATTRIBUTE)
  }, [held])

  return held
}

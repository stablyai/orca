import { useEffect, useRef, useState } from 'react'
import type {
  BrowserGrabPayload,
  GrabIntent
} from '../../../../../../shared/browser/element-grab/browser-grab-types'
import type { GrabModeHook } from '../grab/useGrabMode'
import type { BrowserAnnotateTool } from './browser-annotate-tool-types'

type HeldPick = { payload: BrowserGrabPayload; owner: string }

/**
 * The Grab pick the palette's Copy/Screenshot act on. Palette buttons act on the picked element only; hovering keeps
 * using C/S, so the target can't shift en route. It lasts until the next pick, a tool switch, exit or a new document;
 * the picker rearming after its own copy doesn't end it. A same-document route change (pushState, hash) keeps it
 * only while its element is still in the page, so Copy and Screenshot never describe something that is gone.
 */
export function useHeldGrabPick({
  grab,
  grabIntent,
  activeTool,
  owner,
  pageId,
  currentUrl
}: {
  grab: Pick<GrabModeHook, 'state' | 'payload'>
  grabIntent: GrabIntent
  activeTool: BrowserAnnotateTool | null
  /** The page and document generation; a pick for another one is stale. */
  owner: string
  pageId: string
  /** The page's URL; a change within the same document triggers the presence check. Undefined where unknown. */
  currentUrl: string | undefined
}): BrowserGrabPayload | null {
  const [held, setHeld] = useState<HeldPick | null>(null)
  const pickerPick = grab.state === 'confirming' && grabIntent === 'copy' ? grab.payload : null
  if (pickerPick && pickerPick !== held?.payload) {
    setHeld({ payload: pickerPick, owner })
  }
  if (held && (activeTool !== 'copy' || held.owner !== owner)) {
    setHeld(null)
  }
  const heldPayload = held && activeTool === 'copy' && held.owner === owner ? held.payload : null

  // Only the URL's changes trigger it: the pick itself was just made on an element that is there.
  const checkedUrlRef = useRef(currentUrl)
  useEffect(() => {
    if (checkedUrlRef.current === currentUrl) {
      return
    }
    checkedUrlRef.current = currentUrl
    if (!heldPayload) {
      return
    }
    let current = true
    void window.api.browser
      .grabSelectorPresent({ browserPageId: pageId, selector: heldPayload.target.selector })
      .then((present) => {
        if (current && !present) {
          setHeld((pick) => (pick?.payload === heldPayload ? null : pick))
        }
      })
    return () => {
      current = false
    }
  }, [currentUrl, heldPayload, pageId])

  return heldPayload
}

import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { useEffect, useState } from 'react'
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
  const [lastPickerPick, setLastPickerPick] = useState<BrowserGrabPayload | null>(null)
  const pickerPick = grab.state === 'confirming' && grabIntent === 'copy' ? grab.payload : null
  if (pickerPick && pickerPick !== lastPickerPick) {
    setLastPickerPick(pickerPick)
    setHeld({ payload: pickerPick, owner })
  }
  if (held && (activeTool !== 'copy' || held.owner !== owner)) {
    setHeld(null)
  }
  const heldPayload = held && activeTool === 'copy' && held.owner === owner ? held.payload : null

  const [route, setRoute] = useState({ url: currentUrl, changed: false })
  if (route.url !== currentUrl) {
    setRoute({ url: currentUrl, changed: true })
  }
  useEffect(() => {
    if (!route.changed || !heldPayload) {
      return
    }
    let current = true
    let checking = false
    const check = async (): Promise<void> => {
      if (checking || !current) {
        return
      }
      checking = true
      const present = await window.api.browser
        .grabPickedElementPresent({
          browserPageId: pageId,
          selectionId: heldPayload.page.capturedAt
        })
        .catch(() => null)
      checking = false
      if (!current) {
        return
      }
      if (present === false) {
        setHeld((pick) => (pick?.payload === heldPayload ? null : pick))
      }
    }
    const stopChecking = installWindowVisibilityInterval({
      run: () => {
        void check()
      },
      intervalMs: 300,
      slowWhileUnfocused: true
    })
    return () => {
      current = false
      stopChecking()
    }
  }, [currentUrl, heldPayload, pageId, route.changed])

  return heldPayload
}

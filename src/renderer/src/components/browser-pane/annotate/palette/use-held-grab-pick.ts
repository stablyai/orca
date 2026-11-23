import {
  ipcBrowserGuestToolsTransport,
  type BrowserGuestToolsTransport
} from '../browser-guest-tools-transport'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { useCallback, useEffect, useRef, useState } from 'react'
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
  grab: Pick<GrabModeHook, 'state' | 'payload'> & {
    transport?: Pick<BrowserGuestToolsTransport, 'grabPickedElementPresent'>
  }
  grabIntent: GrabIntent
  activeTool: BrowserAnnotateTool | null
  /** The page and document generation; a pick for another one is stale. */
  owner: string
  pageId: string
  /** The page's URL; a change within the same document triggers the presence check. Undefined where unknown. */
  currentUrl: string | undefined
}): { payload: BrowserGrabPayload | null; retire: (payload: BrowserGrabPayload) => void } {
  const transport = grab.transport ?? ipcBrowserGuestToolsTransport
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

  // One outstanding check per hook, shared across URL changes; its reply affects only the pick it checked.
  const checkingRef = useRef(false)
  useEffect(() => {
    if (!heldPayload) {
      return
    }
    let current = true
    const check = async (): Promise<void> => {
      if (checkingRef.current || !current) {
        return
      }
      checkingRef.current = true
      const present = await transport
        .grabPickedElementPresent({
          browserPageId: pageId,
          selectionId: heldPayload.page.selectionId ?? heldPayload.page.capturedAt
        })
        .catch(() => null)
        .finally(() => {
          checkingRef.current = false
        })
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
  }, [currentUrl, heldPayload, pageId, transport])

  const retire = useCallback((payload: BrowserGrabPayload) => {
    setHeld((pick) => (pick?.payload === payload ? null : pick))
  }, [])
  return { payload: heldPayload, retire }
}

// A terminal tab's chat view covers its pane (NativeChatPaneCover, z-10, opaque), so a pane-top banner
// portaled into the pane is painted under it. While a pane's chat view is open, its chat column
// registers a slot here, and the pane's banners portal into that slot instead: one banner, shown in
// whichever view is on.
import { useSyncExternalStore } from 'react'

const slots = new Map<string, HTMLElement>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** The chat column's banner slot mounts (element) or unmounts (null) for its pane. */
export function setChatBannerSlot(paneKey: string, element: HTMLElement | null): void {
  if (element) {
    if (slots.get(paneKey) === element) {
      return
    }
    slots.set(paneKey, element)
  } else {
    if (!slots.has(paneKey)) {
      return
    }
    slots.delete(paneKey)
  }
  emit()
}

export function readChatBannerSlot(paneKey: string): HTMLElement | null {
  return slots.get(paneKey) ?? null
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The open chat column's slot for this pane; null while the pane shows its terminal. */
export function useChatBannerSlot(paneKey: string): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => readChatBannerSlot(paneKey))
}

export function resetChatBannerSlotsForTest(): void {
  slots.clear()
  emit()
}

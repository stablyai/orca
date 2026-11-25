import { useLayoutEffect, useRef, type RefObject } from 'react'

/** One open viewer, across the images it steps through (each mounts its own body): where focus was
 *  when it opened, and how many bodies are mounted. */
export type NativeChatMediaViewerFocusSession = { opener: Element | null; bodies: number }

export function useNativeChatMediaViewerFocusSession(): RefObject<NativeChatMediaViewerFocusSession> {
  return useRef<NativeChatMediaViewerFocusSession>({ opener: null, bodies: 0 })
}

/** Focus for one image's body: it starts on the media, and only closing the viewer (not stepping to
 *  another image) returns it to what opened the viewer. */
export function useNativeChatMediaViewerFocus(
  session: RefObject<NativeChatMediaViewerFocusSession>,
  focusMedia: () => void
): {
  onOpenAutoFocus: (event: Event) => void
  onCloseAutoFocus: (event: Event) => void
} {
  useLayoutEffect(() => {
    const current = session.current
    current.bodies += 1
    return () => {
      current.bodies -= 1
    }
  }, [session])
  return {
    onOpenAutoFocus: (event) => {
      // The first image records the opener; a stepped-to image finds focus already inside the viewer.
      session.current.opener ??= document.activeElement
      event.preventDefault()
      focusMedia()
    },
    onCloseAutoFocus: (event) => {
      if (session.current.bodies > 0) {
        // Stepped to another image: its body has focus now.
        event.preventDefault()
        return
      }
      const previous = session.current.opener
      session.current.opener = null
      if (previous instanceof HTMLElement && previous.isConnected) {
        event.preventDefault()
        previous.focus({ preventScroll: true })
      }
    }
  }
}

import { useLayoutEffect, useRef, type RefObject } from 'react'

/** One open viewer, across the images it steps through (each mounts its own body): where focus was
 *  when it opened, and how many bodies are mounted. */
export type NativeChatMediaViewerFocusSession = { opener: Element | null; bodies: number }

export function useNativeChatMediaViewerFocusSession(): RefObject<NativeChatMediaViewerFocusSession> {
  return useRef<NativeChatMediaViewerFocusSession>({ opener: null, bodies: 0 })
}

function enterBody(session: NativeChatMediaViewerFocusSession): () => void {
  session.bodies += 1
  return () => {
    session.bodies -= 1
  }
}

function openBody(session: NativeChatMediaViewerFocusSession, event: Event): void {
  // The first image records the opener; a stepped-to image finds focus already inside the viewer.
  if (session.opener === null) {
    session.opener = document.activeElement
  }
  event.preventDefault()
}

function closeBody(session: NativeChatMediaViewerFocusSession, event: Event): void {
  if (session.bodies > 0) {
    // Stepped to another image: its body has focus now.
    event.preventDefault()
    return
  }
  const previous = session.opener
  session.opener = null
  if (previous instanceof HTMLElement && previous.isConnected) {
    event.preventDefault()
    previous.focus({ preventScroll: true })
  }
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
  useLayoutEffect(() => enterBody(session.current), [session])
  return {
    onOpenAutoFocus: (event) => {
      openBody(session.current, event)
      focusMedia()
    },
    onCloseAutoFocus: (event) => closeBody(session.current, event)
  }
}

import { useLayoutEffect, useRef, type RefObject } from 'react'

/** One open viewer, across the images it steps through (each mounts its own body): where focus was
 *  when it opened, the opener's ancestors (to find its replacement), and how many bodies are
 *  mounted. */
export type NativeChatMediaViewerFocusSession = {
  opener: Element | null
  around: Element[]
  bodies: number
}

export function useNativeChatMediaViewerFocusSession(): RefObject<NativeChatMediaViewerFocusSession> {
  return useRef<NativeChatMediaViewerFocusSession>({ opener: null, around: [], bodies: 0 })
}

/** How far up from the opener its replacement is looked for. */
const AROUND_LEVELS = 4

/** What took the opener's place once it is gone (a chip the viewer's marked copy replaced): the last
 *  control like it, by tag and label up to its first colon, in its nearest ancestor still on the
 *  page. Failing that, that ancestor's first focusable control. */
function replacementFor(opener: Element, around: readonly Element[]): HTMLElement | null {
  const label = (element: Element): string =>
    (element.getAttribute('aria-label') ?? '').split(':')[0]
  const container = around.find((element) => element.isConnected)
  if (!container) {
    return null
  }
  const controls = [
    ...container.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])')
  ]
  const alike = controls.filter(
    (control) => control.tagName === opener.tagName && label(control) === label(opener)
  )
  return alike.at(-1) ?? controls[0] ?? null
}

function enterBody(session: NativeChatMediaViewerFocusSession): () => void {
  session.bodies += 1
  return () => {
    session.bodies -= 1
  }
}

// The control the pointer last pressed. A mouse click on a tile may leave focus on the page (macOS
// does not focus buttons on click), and that control is still what opened the viewer.
let pressed: Element | null = null
if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    (event) => {
      pressed =
        event.target instanceof Element
          ? event.target.closest('button, a[href], [tabindex]:not([tabindex="-1"])')
          : null
    },
    true
  )
}

// Named by whatever opens the viewer from elsewhere: the chat's image set closes before handing an
// image over, so neither focus nor the last pressed control (in the closed set) is its tile.
let nominated: Element | null = null

// The draft image that took the opener's place (the marked copy that replaced a reopened chip):
// focus goes to it by its attachment id, whatever number or label it now shows.
let replacement: string | null = null

/** The marked copy that replaced this viewer's chip: closing returns focus to it. */
export function nominateNativeChatMediaViewerReplacement(attachmentId: string | undefined): void {
  replacement = attachmentId ?? null
}

/** The control the next viewer to open returns focus to on close. */
export function nominateNativeChatMediaViewerOpener(opener: Element | null | undefined): void {
  nominated = opener ?? null
}

/** Nominates the tile of a message's image `at`: each image's tile is a child of its group. */
export function nominateNativeChatMediaViewerTile(group: Element | null, at: number): void {
  nominateNativeChatMediaViewerOpener(group?.children[at]?.querySelector('button'))
}

function openBody(session: NativeChatMediaViewerFocusSession, event: Event): void {
  // The first image records the opener; a stepped-to image finds focus already inside the viewer.
  if (session.opener === null) {
    const active = document.activeElement
    session.opener = nominated ?? (active && active !== document.body ? active : pressed)
    nominated = null
    session.around = []
    for (
      let element = session.opener?.parentElement ?? null;
      element && session.around.length < AROUND_LEVELS;
      element = element.parentElement
    ) {
      session.around.push(element)
    }
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
  const around = session.around
  session.opener = null
  session.around = []
  const replacedBy = replacement
    ? document.querySelector<HTMLElement>(
        `[data-native-chat-attachment-id="${CSS.escape(replacement)}"]`
      )
    : null
  replacement = null
  const target =
    previous instanceof HTMLElement && previous.isConnected
      ? previous
      : (replacedBy ?? (previous ? replacementFor(previous, around) : null))
  if (target) {
    event.preventDefault()
    target.focus({ preventScroll: true })
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

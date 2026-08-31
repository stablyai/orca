import { isInertDocumentFocus } from './terminal-paste-target-state'

type InstallInertFocusPasteFallbackArgs = {
  /** TerminalPane root; the pane's own listeners already cover events inside it. */
  container: HTMLElement
  documentTarget?: Document
  onPasteKey: (event: KeyboardEvent) => void
  onPasteEvent: (event: ClipboardEvent) => void
}

export type InertFocusPasteFallback = {
  /** True while this pane is the last surface to have held focus and focus has
   *  since fallen to `<body>` rather than moving to another surface. */
  ownsInertFocus: () => boolean
  dispose: () => void
}

/** A dictation tool, IME, or overlay hands focus back to `<body>`, not to the pane.
 *  The pane's own capture listeners never see those keydown/paste events, so the
 *  chord is dropped with no paste and no error. Recover it at the document, but
 *  only while nothing else has claimed focus or the pointer. */
export function installInertFocusPasteFallback({
  container,
  documentTarget = document,
  onPasteKey,
  onPasteEvent
}: InstallInertFocusPasteFallbackArgs): InertFocusPasteFallback {
  let paneOwnsFocus = containsNode(container, documentTarget.activeElement)

  const onFocusIn = (event: FocusEvent): void => {
    paneOwnsFocus = containsNode(container, event.target)
  }
  // Why: a click on a non-focusable region blurs to <body> without any focusin,
  // so the pointer is the only signal that the user moved on.
  const onPointerDown = (event: Event): void => {
    if (!containsNode(container, event.target)) {
      paneOwnsFocus = false
    }
  }
  // Order matters: these run at the document on every keystroke in the app, once
  // per mounted pane. The two boolean checks short-circuit before any DOM walk,
  // and the layout-touching visibility check only runs for the at-most-one pane
  // that both owns focus and has focus sitting on <body>.
  const ownsInertFocus = (): boolean =>
    paneOwnsFocus &&
    isInertDocumentFocus(documentTarget.activeElement) &&
    isContainerRendered(container)
  const shouldRecover = (event: Event): boolean =>
    ownsInertFocus() && !containsNode(container, event.target)

  const onKeyDown = (event: KeyboardEvent): void => {
    if (shouldRecover(event)) {
      onPasteKey(event)
    }
  }
  const onPaste = (event: ClipboardEvent): void => {
    if (shouldRecover(event)) {
      onPasteEvent(event)
    }
  }

  documentTarget.addEventListener('focusin', onFocusIn, { capture: true })
  documentTarget.addEventListener('pointerdown', onPointerDown, { capture: true })
  documentTarget.addEventListener('keydown', onKeyDown, { capture: true })
  documentTarget.addEventListener('paste', onPaste, { capture: true })

  return {
    ownsInertFocus,
    dispose: () => {
      documentTarget.removeEventListener('focusin', onFocusIn, { capture: true })
      documentTarget.removeEventListener('pointerdown', onPointerDown, { capture: true })
      documentTarget.removeEventListener('keydown', onKeyDown, { capture: true })
      documentTarget.removeEventListener('paste', onPaste, { capture: true })
    }
  }
}

function containsNode(container: HTMLElement, node: EventTarget | Node | null): boolean {
  return node instanceof Node && container.contains(node)
}

/** A pane that stopped being rendered (CSS-hidden floating panel, display:none
 *  background surface) was blurred to `<body>` by the browser with no focusin, so
 *  `paneOwnsFocus` stays stale. Claiming on that swallows the chord for the whole
 *  app at the capture phase and routes the paste into an invisible terminal. */
function isContainerRendered(container: HTMLElement): boolean {
  if (!container.isConnected) {
    return false
  }
  const checkVisibility = (
    container as HTMLElement & {
      checkVisibility?: (options?: { visibilityProperty?: boolean }) => boolean
    }
  ).checkVisibility
  if (typeof checkVisibility === 'function') {
    return checkVisibility.call(container, { visibilityProperty: true })
  }
  // Why: only for engines without checkVisibility. `display` does not cascade to
  // descendants, so reading it off the container alone would report a pane inside
  // a `hidden` wrapper as rendered — failing open, toward claiming the chord. Walk
  // the ancestors instead. `visibility` is inherited, so the container answers for
  // itself. Bounded by tree depth and only reached on this defensive path.
  const view = container.ownerDocument.defaultView
  if (!view) {
    return false
  }
  if (view.getComputedStyle(container).visibility === 'hidden') {
    return false
  }
  for (let node: HTMLElement | null = container; node; node = node.parentElement) {
    if (view.getComputedStyle(node).display === 'none') {
      return false
    }
  }
  return true
}

/** Focus is on <body> but the pane still owns it logically; putting it back before
 *  the shared paste path runs lets that path's dispatch-element guard see the real target. */
export function restoreInertFocusPasteTarget(
  pane: { container: HTMLElement; terminal: { focus: () => void } },
  activeElement: Element | null
): void {
  if (!activeElement || !pane.container.contains(activeElement)) {
    pane.terminal.focus()
  }
}

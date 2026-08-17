import {
  auxWindowFrameName,
  auxWindowFeatures,
  type AuxWindowBounds
} from '../../../shared/aux-window'

export type AuxPaneWindow = {
  window: Window
  /** Container the caller portals into. Lives in the child document. */
  container: HTMLElement
  close: () => void
}

/** Poll interval for geometry. Window move/resize emit no event to the opener. */
const BOUNDS_SAMPLE_MS = 1000

function readBounds(child: Window): AuxWindowBounds | null {
  const { screenX, screenY, outerWidth, outerHeight } = child
  if (!Number.isFinite(screenX) || outerWidth === 0 || outerHeight === 0) {
    return null
  }
  return { x: screenX, y: screenY, width: outerWidth, height: outerHeight }
}

/**
 * Open an `about:blank` child window and mirror the app's stylesheets into it.
 *
 * The child shares this renderer's JS realm — one store, one IPC surface, one
 * PTY delivery path — so only its DOM is separate. Nodes React portals into it
 * are minted in the CHILD realm, which is why pane code must use the
 * realm-resolved DOM helpers rather than bare `window`/`document`/`instanceof`.
 */
export function openAuxPaneWindow(options: {
  groupId: string
  title: string
  bounds: AuxWindowBounds | null
  onClose: () => void
  onBoundsChange: (bounds: AuxWindowBounds) => void
}): AuxPaneWindow | null {
  const child = window.open(
    'about:blank',
    auxWindowFrameName(options.groupId),
    auxWindowFeatures(options.bounds)
  )
  if (!child) {
    return null
  }

  child.document.title = options.title
  copyStyles(child.document)
  // Why: styles injected after open (theme switches, lazily-mounted CSS) would
  // otherwise never reach the child.
  const headObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (isStyleNode(node)) {
          child.document.head.appendChild(child.document.importNode(node, true))
        }
      }
    }
  })
  headObserver.observe(document.head, { childList: true })

  const container = child.document.createElement('div')
  container.style.cssText = 'position:fixed;inset:0;display:flex;overflow:hidden'
  child.document.body.style.cssText = 'margin:0;overflow:hidden'
  child.document.body.appendChild(container)
  // Why: the child inherits the root theme classes (dark mode, platform shell)
  // that Tailwind and the design tokens key off.
  child.document.documentElement.className = document.documentElement.className
  child.document.documentElement.style.cssText = document.documentElement.style.cssText
  const rootObserver = new MutationObserver(() => {
    child.document.documentElement.className = document.documentElement.className
    child.document.documentElement.style.cssText = document.documentElement.style.cssText
  })
  rootObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style']
  })

  // Why: there is no move/resize event the opener can observe on a child
  // window, so sample geometry and store the last good value for restore.
  const boundsTimer = window.setInterval(() => {
    const bounds = readBounds(child)
    if (bounds) {
      options.onBoundsChange(bounds)
    }
  }, BOUNDS_SAMPLE_MS)

  // Why: a child window outlives an opener reload unless we close it, and the
  // listener is removed on teardown so repeated detaches don't accumulate.
  const closeChildWithOpener = (): void => {
    child.close()
  }
  window.addEventListener('pagehide', closeChildWithOpener)

  let closed = false
  const teardown = (): void => {
    headObserver.disconnect()
    rootObserver.disconnect()
    window.clearInterval(boundsTimer)
    window.removeEventListener('pagehide', closeChildWithOpener)
    const bounds = readBounds(child)
    if (bounds) {
      options.onBoundsChange(bounds)
    }
  }
  // Why: close() is the OWNER tearing the window down (unmount, reattach, or
  // StrictMode's dev-only mount/cleanup/mount replay). It must not report a
  // user-initiated close — doing so flips the group back to attached and makes
  // the feature snap shut the moment it opens in a dev build.
  const close = (): void => {
    if (closed) {
      return
    }
    closed = true
    teardown()
    child.removeEventListener('pagehide', onPageHide)
    child.close()
  }
  function onPageHide(): void {
    if (closed) {
      return
    }
    closed = true
    teardown()
    options.onClose()
  }
  // Why: the user can close the OS window directly; the group must come home.
  child.addEventListener('pagehide', onPageHide)

  return { window: child, container, close }
}

function isStyleNode(node: Node): node is HTMLElement {
  // Why: cross-realm — `node` comes from this document, so a plain nodeName
  // check avoids depending on which realm minted it.
  return node.nodeName === 'STYLE' || node.nodeName === 'LINK'
}

function copyStyles(target: Document): void {
  for (const node of document.head.querySelectorAll('link[rel="stylesheet"], style')) {
    target.head.appendChild(target.importNode(node, true))
  }
  // Why: constructed stylesheets (CSSOM `.sheet` writes) are invisible to both
  // node cloning and MutationObserver — VS Code carries the same carve-out.
  if (document.adoptedStyleSheets.length > 0) {
    try {
      target.adoptedStyleSheets = [...document.adoptedStyleSheets]
    } catch {
      // Non-fatal: those styles simply do not reach the child. Throwing here
      // would strand an already-open window with no close() wired to it.
    }
  }
}

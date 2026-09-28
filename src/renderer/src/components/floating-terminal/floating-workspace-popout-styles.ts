const CLONE_MARKER_ATTRIBUTE = 'data-floating-workspace-style-clone'

function linkSyncKey(element: Element): string | null {
  // Why getAttribute, not .href: the popout is about:blank so a resolved URL never
  // matches main's, and every sync would append another duplicate.
  const href = element.getAttribute('href')
  if (!href) {
    return null
  }
  return `link:${href}|${element.getAttribute('media') ?? ''}`
}

function styleSyncKey(element: Element): string | null {
  const text = element.textContent ?? ''
  if (text.trim() === '') {
    return null
  }
  return `style:${text}`
}

function sourceSyncKey(element: Element): string | null {
  return element.tagName === 'LINK' ? linkSyncKey(element) : styleSyncKey(element)
}

// Why one-way main→popout with order preserved: lazily-added sheets never reach the
// popout otherwise, and appending them out of order reshuffles the cascade.
export function syncPopoutStyles(sourceRoot: ParentNode, popupHead: HTMLHeadElement): boolean {
  const wanted = new Map<string, Element>()
  for (const source of Array.from(sourceRoot.querySelectorAll('link[rel="stylesheet"], style'))) {
    const key = sourceSyncKey(source)
    if (key !== null && !wanted.has(key)) {
      wanted.set(key, source)
    }
  }
  const unmatched = new Map<string, Element>()
  for (const clone of Array.from(popupHead.querySelectorAll(`[${CLONE_MARKER_ATTRIBUTE}]`))) {
    const key = clone.getAttribute(CLONE_MARKER_ATTRIBUTE)
    if (key !== null && !unmatched.has(key)) {
      unmatched.set(key, clone)
    }
  }
  let changed = false
  for (const [key, source] of wanted) {
    const node = unmatched.get(key)
    if (node) {
      popupHead.appendChild(node)
      unmatched.delete(key)
      continue
    }
    const clone = source.cloneNode(true) as Element
    clone.setAttribute(CLONE_MARKER_ATTRIBUTE, key)
    popupHead.appendChild(clone)
    changed = true
  }
  for (const [key, node] of unmatched) {
    if (!wanted.has(key)) {
      node.remove()
      changed = true
    }
  }
  return changed
}

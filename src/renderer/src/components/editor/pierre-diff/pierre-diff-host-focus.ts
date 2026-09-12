/** Light-DOM Node.contains() does not see the focused node inside an open shadow tree. */
export function isActiveElementInsideHost(host: HTMLElement, active: Element | null): boolean {
  if (!(active instanceof Node)) {
    return false
  }
  if (host === active || host.contains(active)) {
    return true
  }
  let node: Element | null = active
  while (node) {
    const root = node.getRootNode()
    if (!(root instanceof ShadowRoot)) {
      return false
    }
    if (host === root.host || host.contains(root.host)) {
      return true
    }
    node = root.host
  }
  return false
}

function isEditableComposedOrigin(path: EventTarget[]): boolean {
  return path.some((node) => {
    if (!(node instanceof HTMLElement)) {
      return false
    }
    return (
      node.isContentEditable ||
      node.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
    )
  })
}

/**
 * Focus the light-DOM keyboard host only when the click is not already inside a
 * real editor control. Pierre's file editor lives in an open shadow tree, so a
 * naive contains(activeElement) check would steal caret/IME focus on every click.
 */
export function shouldFocusPierreDiffHost(
  host: HTMLElement,
  active: Element | null,
  event: Pick<Event, 'composedPath'>
): boolean {
  if (isActiveElementInsideHost(host, active)) {
    return false
  }
  return !isEditableComposedOrigin(event.composedPath())
}

/**
 * Pierre renders into a shadow root, so `document.activeElement` stops at the
 * host. Walk shadow roots to reach the element that actually holds focus.
 */
export function getDeepActiveElement(): Element | null {
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement
  }
  return active
}

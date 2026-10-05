/**
 * One pane's presentation token, as a host publishes it and checks it: equal only while no
 * accepted view/owner intent or launch reached the pane's tab and the pane kept its PTY. Exit side
 * effects, title/geometry writes and sibling panes never change it.
 */
export function formatPanePresentationToken(
  epoch: string,
  intentRevision: number,
  boundPtyId: string | null | undefined
): string {
  return `${epoch}.${intentRevision}.${bindingDigest(boundPtyId ?? '')}`
}

// Why a digest: PTY ids can be long; the token only needs to change when the binding does.
function bindingDigest(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

import { isNode } from '../../lib/cross-realm-dom-predicates'
export function keyboardEventBelongsToScope(event: KeyboardEvent, scope: HTMLElement): boolean {
  const target = event.target
  if (isNode(target) && scope.contains(target)) {
    return true
  }
  const activeElement = scope.ownerDocument.activeElement
  return isNode(activeElement) && scope.contains(activeElement)
}

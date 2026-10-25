export function findPaneChildren(parent: HTMLElement): HTMLElement[] {
  return Array.from(parent.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      (child.classList.contains('pane') || child.classList.contains('pane-split'))
  )
}

export function getSplitDirection(split: HTMLElement): 'vertical' | 'horizontal' {
  return split.classList.contains('is-horizontal') ? 'horizontal' : 'vertical'
}

function getEqualizeWeight(
  el: HTMLElement,
  direction: 'vertical' | 'horizontal',
  weights: Map<HTMLElement, number>
): number {
  if (!el.classList.contains('pane-split') || getSplitDirection(el) !== direction) {
    return 1
  }

  // Element keys suffice because parent axis is fixed within one sweep; a new map per sweep prevents stale split/close/resize weights.
  const cached = weights.get(el)
  if (cached !== undefined) {
    return cached
  }
  const children = findPaneChildren(el)
  const weight = Math.max(
    1,
    children.reduce((sum, child) => sum + getEqualizeWeight(child, direction, weights), 0)
  )
  weights.set(el, weight)
  return weight
}

export function equalizePaneSplitSizes(root: HTMLElement | null): boolean {
  if (!root) {
    return false
  }

  const weights = new Map<HTMLElement, number>()
  let changed = false
  const visit = (el: HTMLElement): void => {
    if (!el.classList.contains('pane-split')) {
      return
    }

    const direction = getSplitDirection(el)
    const children = findPaneChildren(el)
    if (children.length >= 2) {
      for (const child of children) {
        // Weight same-axis nested splits by pane count so three peers become thirds, not 50/25/25.
        const weight = getEqualizeWeight(child, direction, weights)
        const nextFlex = `${weight} 1 0%`
        if (child.style.flex !== nextFlex) {
          child.style.flex = nextFlex
          changed = true
        }
      }
    }

    for (const child of children) {
      visit(child)
    }
  }

  visit(root)
  return changed
}

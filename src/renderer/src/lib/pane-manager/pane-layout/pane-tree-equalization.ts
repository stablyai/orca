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

/**
 * Equalizes every pane along `split`'s axis in the same row or column, however the binary tree
 * nests them; cross-axis splits keep their ratios. Returns the outermost split it resized, or null.
 */
export function equalizeSameAxisPaneRun(split: HTMLElement): HTMLElement | null {
  const direction = getSplitDirection(split)
  let runRoot = split
  for (
    let parent = runRoot.parentElement;
    parent?.classList.contains('pane-split') && getSplitDirection(parent) === direction;
    parent = parent.parentElement
  ) {
    runRoot = parent
  }

  const weights = new Map<HTMLElement, number>()
  let changed = false
  const visit = (el: HTMLElement): void => {
    for (const child of findPaneChildren(el)) {
      const nextFlex = `${getEqualizeWeight(child, direction, weights)} 1 0%`
      if (child.style.flex !== nextFlex) {
        child.style.flex = nextFlex
        changed = true
      }
      if (child.classList.contains('pane-split') && getSplitDirection(child) === direction) {
        visit(child)
      }
    }
  }

  visit(runRoot)
  return changed ? runRoot : null
}

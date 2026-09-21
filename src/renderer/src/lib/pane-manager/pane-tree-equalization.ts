/** Find non-divider children (panes and splits) of an element. */
export function findPaneChildren(parent: HTMLElement): HTMLElement[] {
  return Array.from(parent.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      (child.classList.contains('pane') || child.classList.contains('pane-split'))
  )
}

function getSplitDirection(split: HTMLElement): 'vertical' | 'horizontal' {
  return split.classList.contains('is-horizontal') ? 'horizontal' : 'vertical'
}

function getEqualizeWeight(el: HTMLElement, direction: 'vertical' | 'horizontal'): number {
  if (!el.classList.contains('pane-split') || getSplitDirection(el) !== direction) {
    return 1
  }

  const children = findPaneChildren(el)
  return Math.max(
    1,
    children.reduce((sum, child) => sum + getEqualizeWeight(child, direction), 0)
  )
}

export function equalizePaneSplitSizes(root: HTMLElement | null): boolean {
  if (!root) {
    return false
  }

  let changed = false
  const visit = (el: HTMLElement): void => {
    if (!el.classList.contains('pane-split')) {
      return
    }

    const direction = getSplitDirection(el)
    const children = findPaneChildren(el)
    if (children.length >= 2) {
      for (const child of children) {
        // Why: same-axis nested splits need pane-count weighting so three
        // side-by-side panes become thirds, not 50/25/25.
        const weight = getEqualizeWeight(child, direction)
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

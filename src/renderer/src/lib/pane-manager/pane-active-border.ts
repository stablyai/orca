import type { PaneStyleOptions, ManagedPaneInternal } from './pane-manager-types'
import { DIVIDER_HIT_PADDING } from './pane-divider'

// ---------------------------------------------------------------------------
// Active-pane presentation: opacity dimming + the active-pane border
// ---------------------------------------------------------------------------

export function applyActivePaneStyles(
  root: HTMLElement,
  panes: Iterable<ManagedPaneInternal>,
  activePaneId: number | null,
  styleOptions: PaneStyleOptions
): void {
  const { activePaneOpacity = 1, inactivePaneOpacity = 1, opacityTransitionMs = 0 } = styleOptions

  const transition = opacityTransitionMs > 0 ? `opacity ${opacityTransitionMs}ms ease` : ''
  let activeContainer: HTMLElement | null = null

  for (const pane of panes) {
    const isActive = pane.id === activePaneId
    pane.container.style.opacity = String(isActive ? activePaneOpacity : inactivePaneOpacity)
    pane.container.style.transition = transition
    if (isActive) {
      activeContainer = pane.container
    }
  }

  updateActivePaneBorder(root, activeContainer, styleOptions)
}

const borderObservers = new WeakMap<HTMLElement, ResizeObserver>()

/** Lives in the split root (panes clip overflow) so it can cover the divider lines the pane touches. */
function updateActivePaneBorder(
  root: HTMLElement,
  activeContainer: HTMLElement | null,
  styleOptions: PaneStyleOptions
): void {
  const existing = root.querySelector<HTMLElement>(':scope > .pane-active-border')
  disposeActivePaneBorder(root)
  if (!activeContainer || !styleOptions.activePaneBorderEnabled) {
    existing?.remove()
    return
  }

  const border = existing ?? root.appendChild(document.createElement('div'))
  border.className = 'pane-active-border'
  const thickness = styleOptions.dividerThicknessPx ?? 4
  border.style.borderWidth = `${thickness}px`
  border.style.borderColor = styleOptions.activePaneBorderColor ?? 'transparent'
  // Reach across the divider gutter so the stroke lands exactly on its line.
  const reach = DIVIDER_HIT_PADDING + thickness
  const active = activeContainer

  const position = (): void => {
    const rootRect = root.getBoundingClientRect()
    const rect = active.getBoundingClientRect()
    // Edges short of the root edge sit on a divider.
    const left = rect.left > rootRect.left + 0.5 ? reach : 0
    const right = rect.right < rootRect.right - 0.5 ? reach : 0
    const top = rect.top > rootRect.top + 0.5 ? reach : 0
    const bottom = rect.bottom < rootRect.bottom - 0.5 ? reach : 0
    border.style.left = `${rect.left - rootRect.left - left}px`
    border.style.top = `${rect.top - rootRect.top - top}px`
    border.style.width = `${rect.width + left + right}px`
    border.style.height = `${rect.height + top + bottom}px`
  }
  position()

  if (typeof ResizeObserver !== 'undefined') {
    // Divider drags resize the pane without re-running style application.
    const observer = new ResizeObserver(position)
    observer.observe(activeContainer)
    borderObservers.set(root, observer)
  }
}

/** Call on manager teardown: the root element (and the observer) outlive it. */
export function disposeActivePaneBorder(root: HTMLElement): void {
  borderObservers.get(root)?.disconnect()
  borderObservers.delete(root)
}

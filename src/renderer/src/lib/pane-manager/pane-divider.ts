import type { PaneStyleOptions, ManagedPaneInternal } from './pane-manager-types'
import { attachDividerDrag, disposeDividerDrag, type DividerCallbacks } from './pane-divider-drag'
export { createDividerFlexFrameScheduler } from './pane-divider-drag'

// ---------------------------------------------------------------------------
// Divider creation & drag-to-resize
// ---------------------------------------------------------------------------

/** Total hit area size = visible thickness + invisible padding on each side */
export function getDividerHitSize(styleOptions: PaneStyleOptions): number {
  const thickness = styleOptions.dividerThicknessPx ?? 4
  const HIT_PADDING = 3
  return thickness + HIT_PADDING * 2
}

export function createDivider(
  isVertical: boolean,
  styleOptions: PaneStyleOptions,
  callbacks: DividerCallbacks
): HTMLElement {
  const divider = document.createElement('div')
  divider.className = `pane-divider ${isVertical ? 'is-vertical' : 'is-horizontal'}`

  // Ghostty-style: the element itself is a wide transparent hit area for easy
  // grabbing. The visible line is drawn by a CSS ::after pseudo-element
  // (see main.css), so `background` on the element stays transparent.
  const hitSize = getDividerHitSize(styleOptions)
  if (isVertical) {
    divider.style.width = `${hitSize}px`
    divider.style.cursor = 'col-resize'
  } else {
    divider.style.height = `${hitSize}px`
    divider.style.cursor = 'row-resize'
  }
  divider.style.flex = 'none'
  divider.style.position = 'relative'

  attachDividerDrag(divider, isVertical, callbacks)
  return divider
}

export function disposeDivider(divider: HTMLElement): void {
  disposeDividerDrag(divider)
}

export function disposeDividersIn(root: HTMLElement): void {
  const dividers = root.querySelectorAll('.pane-divider')
  for (const divider of dividers) {
    disposeDivider(divider as HTMLElement)
  }
}

export function applyDividerStyles(root: HTMLElement, styleOptions: PaneStyleOptions): void {
  const thickness = styleOptions.dividerThicknessPx ?? 4
  const hitSize = getDividerHitSize(styleOptions)

  const dividers = root.querySelectorAll('.pane-divider')
  for (const div of dividers) {
    const el = div as HTMLElement
    const isVertical = el.classList.contains('is-vertical')
    if (isVertical) {
      el.style.width = `${hitSize}px`
    } else {
      el.style.height = `${hitSize}px`
    }
    // Store the visual thickness for the CSS ::after pseudo-element
    el.style.setProperty('--divider-thickness', `${thickness}px`)
    // Extension amount lets ::after reach the center of perpendicular
    // dividers so intersecting splits visually connect.
    el.style.setProperty('--divider-extension', `${hitSize / 2}px`)
  }
}

export function applyPaneOpacity(
  panes: Iterable<ManagedPaneInternal>,
  activePaneId: number | null,
  styleOptions: PaneStyleOptions
): void {
  const { activePaneOpacity = 1, inactivePaneOpacity = 1, opacityTransitionMs = 0 } = styleOptions

  const transition = opacityTransitionMs > 0 ? `opacity ${opacityTransitionMs}ms ease` : ''

  for (const pane of panes) {
    const isActive = pane.id === activePaneId
    pane.container.style.opacity = String(isActive ? activePaneOpacity : inactivePaneOpacity)
    pane.container.style.transition = transition
  }
}

export function applyRootBackground(root: HTMLElement, styleOptions: PaneStyleOptions): void {
  if (styleOptions.splitBackground) {
    root.style.background = styleOptions.splitBackground
  }
  if (styleOptions.paddingX !== undefined) {
    root.style.setProperty('--pane-padding-x', `${styleOptions.paddingX}px`)
  }
  if (styleOptions.paddingY !== undefined) {
    root.style.setProperty('--pane-padding-y', `${styleOptions.paddingY}px`)
  }
}

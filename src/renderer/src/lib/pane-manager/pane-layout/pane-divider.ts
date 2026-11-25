import type { PaneStyleOptions, ManagedPaneInternal } from '../pane-manager-types'
import { attachDividerDrag, disposeDividerDrag, type DividerCallbacks } from './pane-divider-drag'

function getDividerThickness(styleOptions: PaneStyleOptions): number {
  return styleOptions.dividerThicknessPx ?? 4
}

export function createDivider(
  isVertical: boolean,
  styleOptions: PaneStyleOptions,
  callbacks: DividerCallbacks
): HTMLElement {
  const divider = document.createElement('div')
  divider.className = `pane-divider ${isVertical ? 'is-vertical' : 'is-horizontal'}`

  // The element is only as wide as the visible line; CSS ::before widens the grab area over a neighbor.
  const thickness = getDividerThickness(styleOptions)
  if (isVertical) {
    divider.style.width = `${thickness}px`
    divider.style.cursor = 'col-resize'
  } else {
    divider.style.height = `${thickness}px`
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
  const thickness = getDividerThickness(styleOptions)

  const dividers = root.querySelectorAll('.pane-divider')
  for (const div of dividers) {
    const el = div as HTMLElement
    const isVertical = el.classList.contains('is-vertical')
    if (isVertical) {
      el.style.width = `${thickness}px`
    } else {
      el.style.height = `${thickness}px`
    }
    el.style.setProperty('--divider-thickness', `${thickness}px`)
    // Extend ::after to perpendicular divider centers so split intersections connect.
    el.style.setProperty('--divider-extension', `${thickness / 2}px`)
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

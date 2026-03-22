import type { PaneStyleOptions, ManagedPaneInternal } from './pane-manager-types'

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
  callbacks: {
    refitPanesUnder: (el: HTMLElement) => void
    onLayoutChanged?: () => void
  }
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

function attachDividerDrag(
  divider: HTMLElement,
  isVertical: boolean,
  callbacks: {
    refitPanesUnder: (el: HTMLElement) => void
    onLayoutChanged?: () => void
  }
): void {
  const MIN_PANE_SIZE = 50

  let dragging = false
  let didMove = false
  let startPos = 0
  let prevFlex = 0
  let nextFlex = 0
  let totalSize = 0
  let prevEl: HTMLElement | null = null
  let nextEl: HTMLElement | null = null

  const onPointerDown = (e: PointerEvent): void => {
    e.preventDefault()
    divider.setPointerCapture(e.pointerId)
    divider.classList.add('is-dragging')
    dragging = true
    didMove = false

    startPos = isVertical ? e.clientX : e.clientY

    // Find previous and next pane/split siblings
    prevEl = divider.previousElementSibling as HTMLElement | null
    nextEl = divider.nextElementSibling as HTMLElement | null

    if (!prevEl || !nextEl) {
      return
    }

    const prevRect = prevEl.getBoundingClientRect()
    const nextRect = nextEl.getBoundingClientRect()
    const prevSize = isVertical ? prevRect.width : prevRect.height
    const nextSize = isVertical ? nextRect.width : nextRect.height
    totalSize = prevSize + nextSize

    // Store current proportions as flex-basis values
    prevFlex = prevSize
    nextFlex = nextSize
  }

  const onPointerMove = (e: PointerEvent): void => {
    if (!dragging || !prevEl || !nextEl) {
      return
    }
    didMove = true

    const currentPos = isVertical ? e.clientX : e.clientY
    const delta = currentPos - startPos

    let newPrev = prevFlex + delta
    let newNext = nextFlex - delta

    // Enforce minimum pane size
    if (newPrev < MIN_PANE_SIZE) {
      newPrev = MIN_PANE_SIZE
      newNext = totalSize - MIN_PANE_SIZE
    }
    if (newNext < MIN_PANE_SIZE) {
      newNext = MIN_PANE_SIZE
      newPrev = totalSize - MIN_PANE_SIZE
    }

    // Use flex-grow proportionally
    prevEl.style.flex = `${newPrev} 1 0%`
    nextEl.style.flex = `${newNext} 1 0%`

    // Refit terminals in affected panes
    callbacks.refitPanesUnder(prevEl)
    callbacks.refitPanesUnder(nextEl)
  }

  const onPointerUp = (e: PointerEvent): void => {
    if (!dragging) {
      return
    }
    dragging = false
    divider.releasePointerCapture(e.pointerId)
    divider.classList.remove('is-dragging')
    prevEl = null
    nextEl = null

    // Persist updated ratios after a real drag
    if (didMove) {
      callbacks.onLayoutChanged?.()
    }
  }

  // Ghostty-style: double-click divider to equalize sibling panes
  const onDoubleClick = (): void => {
    const prev = divider.previousElementSibling as HTMLElement | null
    const next = divider.nextElementSibling as HTMLElement | null
    if (!prev || !next) {
      return
    }

    prev.style.flex = '1 1 0%'
    next.style.flex = '1 1 0%'

    callbacks.refitPanesUnder(prev)
    callbacks.refitPanesUnder(next)
    callbacks.onLayoutChanged?.()
  }

  divider.addEventListener('pointerdown', onPointerDown)
  divider.addEventListener('pointermove', onPointerMove)
  divider.addEventListener('pointerup', onPointerUp)
  divider.addEventListener('dblclick', onDoubleClick)
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
}

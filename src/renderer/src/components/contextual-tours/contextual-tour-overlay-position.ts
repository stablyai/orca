import type { CSSProperties } from 'react'
import type { ContextualTourStepPlacement } from '../../../../shared/contextual-tours'
import type { ContextualTourPanelPlacement } from './contextual-tour-panel-position'
import {
  clampContextualTourPanelPosition,
  getContextualTourTargetRectInHost
} from './contextual-tour-panel-position'

const PANEL_FALLBACK_SIZE = { width: 304, height: 172 }

export type ContextualTourOverlayPanelPosition = {
  panelPosition: CSSProperties & { '--contextual-tour-arrow-offset'?: string }
  panelPlacement: ContextualTourPanelPlacement
}

/**
 * Returns the CSS position and placement for a tour panel rendered inside an overlay host,
 * clamping coordinates to host space so clipped containers don't obscure the panel.
 */
export function getContextualTourOverlayPanelPosition(args: {
  targetRect: DOMRect
  panelElement: HTMLElement | null
  panelHost: HTMLElement | null
  preferredPlacement?: ContextualTourStepPlacement
  viewport: { width: number; height: number }
}): ContextualTourOverlayPanelPosition {
  const panelRect = args.panelElement?.getBoundingClientRect()
  const panel = panelRect
    ? { width: panelRect.width, height: panelRect.height }
    : PANEL_FALLBACK_SIZE
  // Why: hosted panels portal into dialog/sheet content whose overflow clips
  // them, so position and clamp in host space — viewport clamping can park the
  // panel in the clipped region outside the host and leave only a sliver visible.
  const hostRect = args.panelHost?.getBoundingClientRect()
  const clamped = clampContextualTourPanelPosition({
    targetRect: hostRect
      ? getContextualTourTargetRectInHost(args.targetRect, hostRect)
      : args.targetRect,
    viewport: hostRect ? { width: hostRect.width, height: hostRect.height } : args.viewport,
    panel,
    preferredPlacement: args.preferredPlacement
  })
  return {
    panelPlacement: clamped.placement,
    panelPosition: {
      left: clamped.left,
      top: clamped.top,
      '--contextual-tour-arrow-offset': `${clamped.arrowOffset}px`
    }
  }
}

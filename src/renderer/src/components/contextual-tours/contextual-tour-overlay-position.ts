import type { CSSProperties } from 'react'
import type { ContextualTourStepPlacement } from '../../../../shared/contextual-tours'
import type { ContextualTourPanelPlacement } from './contextual-tour-panel-position'
import {
  clampContextualTourPanelPosition,
  getContextualTourPanelCssPosition
} from './contextual-tour-panel-position'

const PANEL_FALLBACK_SIZE = { width: 304, height: 172 }

export type ContextualTourOverlayPanelPosition = {
  panelPosition: CSSProperties & { '--contextual-tour-arrow-offset'?: string }
  panelPlacement: ContextualTourPanelPlacement
}

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
  const clamped = clampContextualTourPanelPosition({
    targetRect: args.targetRect,
    viewport: args.viewport,
    panel,
    preferredPlacement: args.preferredPlacement
  })
  const cssPosition = getContextualTourPanelCssPosition({
    position: clamped,
    panelHostRect: args.panelHost?.getBoundingClientRect()
  })
  return {
    panelPlacement: clamped.placement,
    panelPosition: {
      left: cssPosition.left,
      top: cssPosition.top,
      '--contextual-tour-arrow-offset': `${cssPosition.arrowOffset}px`
    }
  }
}

import type { CSSProperties, JSX } from 'react'
import type { ContextualTourPanelPlacement } from './contextual-tour-panel-position'

export function ContextualTourArrow({
  placement
}: {
  placement: ContextualTourPanelPlacement
}): JSX.Element {
  // Why: a small triangle pointing at the target makes the panel/target
  // relationship readable when the user's eye starts on the panel.
  const offsetCss = 'var(--contextual-tour-arrow-offset, 50%)'
  const horizontal = placement === 'top' || placement === 'bottom'
  const longSide = 12
  const shortSide = 6
  const wrapperStyle: CSSProperties = horizontal
    ? {
        width: longSide,
        height: shortSide,
        left: offsetCss,
        transform: 'translateX(-50%)',
        ...(placement === 'top' ? { top: '100%' } : { bottom: '100%' })
      }
    : {
        width: shortSide,
        height: longSide,
        top: offsetCss,
        transform: 'translateY(-50%)',
        ...(placement === 'left' ? { left: '100%' } : { right: '100%' })
      }
  const path =
    placement === 'top'
      ? 'M0 0 L6 6 L12 0'
      : placement === 'bottom'
        ? 'M0 6 L6 0 L12 6'
        : placement === 'left'
          ? 'M0 0 L6 6 L0 12'
          : 'M6 0 L0 6 L6 12'
  const maskPath =
    placement === 'top'
      ? 'M0 0 L12 0'
      : placement === 'bottom'
        ? 'M0 6 L12 6'
        : placement === 'left'
          ? 'M0 0 L0 12'
          : 'M6 0 L6 12'
  return (
    <span aria-hidden="true" className="absolute block" style={wrapperStyle}>
      <svg
        viewBox={horizontal ? '0 0 12 6' : '0 0 6 12'}
        width={horizontal ? longSide : shortSide}
        height={horizontal ? shortSide : longSide}
        className="overflow-visible"
        preserveAspectRatio="none"
      >
        <path
          d={path}
          className="fill-popover stroke-border"
          strokeWidth={1}
          strokeLinejoin="round"
        />
        {/* Why: hide the join with the panel border so the panel edge reads as continuous. */}
        <path d={maskPath} className="stroke-popover" strokeWidth={1.5} fill="none" />
      </svg>
    </span>
  )
}

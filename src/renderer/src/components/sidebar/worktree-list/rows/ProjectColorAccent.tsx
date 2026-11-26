import type React from 'react'
import type { LineageRowFrame } from '../listing/lineage-row-projection'
import {
  getProjectColorAccentHeaderTintStyle,
  getProjectColorAccentRailStyle
} from './project-color-accent'

/** The badge-color rail down the left of a row under a project header. */
export function ProjectColorAccentRail(props: {
  color: string | undefined
  groupDepth: number
  frame: LineageRowFrame
}): React.JSX.Element | null {
  if (!props.color) {
    return null
  }
  return (
    <span
      aria-hidden
      data-project-color-accent-rail=""
      className="pointer-events-none absolute w-0.5"
      style={getProjectColorAccentRailStyle(props.color, props.groupDepth, props.frame)}
    />
  )
}

/** The tinted band behind a project header; its left border starts the rail its rows continue. */
export function ProjectColorAccentHeaderTint(props: {
  color: string | undefined
  groupDepth: number
}): React.JSX.Element | null {
  if (!props.color) {
    return null
  }
  return (
    <span
      aria-hidden
      data-project-color-accent-header=""
      // Why: -z-10 inside the header's isolated stacking context keeps the tint beneath the label.
      className="pointer-events-none absolute inset-y-0 right-0 -z-10 border-l-2"
      style={getProjectColorAccentHeaderTintStyle(props.color, props.groupDepth)}
    />
  )
}

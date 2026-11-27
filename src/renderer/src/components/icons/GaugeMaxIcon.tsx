import type React from 'react'

/** A gauge with its needle pinned past max: a usage limit hit. Drawn on lucide's 24 px grid and
 *  2 px stroke (lucide's gauge stops short of max). */
export function GaugeMaxIcon({
  className,
  strokeWidth = 2
}: {
  className?: string
  strokeWidth?: number
}): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
      <path d="m12 14 5-5" />
      <path d="M19 6l1.5-1.5" />
    </svg>
  )
}

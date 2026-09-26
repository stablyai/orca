import React from 'react'

// Why: flatten the official Redmine product mark (the three stacked leaf
// glyphs) so it matches Orca's monochrome provider icons instead of the
// grey/red wordmark. Coordinates are the raw logo paths translated to a
// tight 0..64 x 0..66 box; color comes from the caller via `currentColor`.
export function RedmineIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 64 66" aria-hidden className={className} fill="currentColor">
      <g transform="translate(-59.85,-308.69)">
        <path d="m 59.847143,374.6913 21,0 1.5,-18.00125 -19.50125,-4.49875 -2.99875,22.5 z" />
        <path d="m 63.597143,349.19005 18.75,4.5 4.5,-15.75 -15.75,-8.24875 -7.5,19.49875 z" />
        <path d="m 72.595893,326.69005 15,8.25 12.00125,-8.25 -11.25,-12.75 -15.75125,12.75 z" />
        <path d="m 92.097143,311.69005 11.249997,13.5 10.49875,0 9.75125,-13.5 -9.75125,-3 -10.7625,0 -10.986247,3 z" />
      </g>
    </svg>
  )
}

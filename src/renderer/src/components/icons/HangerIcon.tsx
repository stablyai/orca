import type React from 'react'

/** A clothes hanger, drawn on lucide's 24 px grid and 2 px stroke (lucide has none). */
export function HangerIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <path d="M10 6a2 2 0 1 1 2 2v1.5" />
      <path d="M12 9.5 3.2 15.8A1.2 1.2 0 0 0 3.9 18h16.2a1.2 1.2 0 0 0 .7-2.2Z" />
    </svg>
  )
}

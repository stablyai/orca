import React from 'react'

// Why: the Huly logo (a stylized "H") is referenced from the integration
// card, the sidebar, and the source picker. Keeping a single source avoids
// drift in the path data and lets every caller pick its own size/color via
// `currentColor`.
export function HulyIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M3 3h4.5v6.75h9V3H21v18h-4.5v-6.75h-9V21H3V3Z" />
    </svg>
  )
}

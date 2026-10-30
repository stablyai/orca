import React from 'react'

export function PlaneIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M2.5 12.875 20.875 3.5 12.5 21.875 10.75 14.5 2.5 12.875Zm9.25.125 5.5-6.5-6.5 5.5.5 4.5.5-3.5Z" />
    </svg>
  )
}

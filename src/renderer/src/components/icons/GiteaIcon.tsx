import React from 'react'

// Why: the Gitea/Forgejo mark is referenced from multiple surfaces (settings
// task-provider toggle, sidebar nav shortcut, task-source picker). Keeping a
// single source avoids path-data drift and lets every caller pick its own
// size/color via `currentColor`.
export function GiteaIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M3 6h12v7.5A4.5 4.5 0 0 1 10.5 18h-3A4.5 4.5 0 0 1 3 13.5V6Zm12 1.75h2.75a2.75 2.75 0 1 1 0 5.5H15v-1.75h2.75a1 1 0 0 0 0-2H15V7.75ZM4 19.5h10V21H4v-1.5Z" />
    </svg>
  )
}

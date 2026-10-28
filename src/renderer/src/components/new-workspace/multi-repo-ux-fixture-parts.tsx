// Shared pieces of the multi-repo UX fixtures; kept out of *.fixture.tsx so the registry does not load it as a fixture.
import React from 'react'

export function RepoDot({ color }: { color: string }): React.JSX.Element {
  return (
    <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />
  )
}

export const REPOS = [
  { name: 'api', color: '#4f8cff' },
  { name: 'web', color: '#e0a030' },
  { name: 'infra', color: '#4fb286' }
]

export function ComposerShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="w-full rounded-xl border border-border bg-card p-5 shadow-floating">
      {children}
    </div>
  )
}

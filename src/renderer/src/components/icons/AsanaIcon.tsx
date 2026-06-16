export function AsanaIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      {/* Why: render the Asana three-dot mark in a single color so it matches
      Orca's monochrome provider icons instead of the branded gradient tile. */}
      <circle cx="12" cy="6.4" r="4.2" />
      <circle cx="6.6" cy="15.6" r="4.2" />
      <circle cx="17.4" cy="15.6" r="4.2" />
    </svg>
  )
}

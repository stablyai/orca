export function TrelloIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="none">
      <rect x="2" y="2" width="20" height="20" rx="4" fill="currentColor" />
      <rect x="6" y="6" width="4.75" height="11.5" rx="1.25" fill="var(--background)" />
      <rect x="13.25" y="6" width="4.75" height="7.5" rx="1.25" fill="var(--background)" />
    </svg>
  )
}

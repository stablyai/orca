export function YouTrackIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="none">
      {/* Why: a monochrome "YT" tile so it sits with Orca's other provider marks. */}
      <rect x="1.5" y="1.5" width="21" height="21" rx="5" stroke="currentColor" strokeWidth="2" />
      <path
        d="M5.5 7l3 4.5V17M11.5 7l-3 4.5M12.5 7h6.5M15.75 7v10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

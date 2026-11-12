export function ToknIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={className} fill="none">
      {/* tokn's published mark (toknhq.com/logo.svg) as a monochrome provider glyph. */}
      <path
        d="M12 5H7a2.5 2.5 0 0 0-2.5 2.5v17A2.5 2.5 0 0 0 7 27h5"
        stroke="currentColor"
        strokeWidth="4.5"
        strokeLinecap="round"
      />
      <path
        d="M20 5h5a2.5 2.5 0 0 1 2.5 2.5v17A2.5 2.5 0 0 1 25 27h-5"
        stroke="currentColor"
        strokeWidth="4.5"
        strokeLinecap="round"
      />
      <rect x="13" y="13" width="6" height="6" rx="2" fill="currentColor" />
    </svg>
  )
}

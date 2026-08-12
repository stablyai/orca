export function BeadsIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={className} fill="none">
      {/* Why: flatten the bd brand tile (rounded square + wordmark) to currentColor so it
      matches Orca's monochrome provider icons instead of rendering as a branded tile. */}
      <rect x="1.5" y="1.5" width="29" height="29" rx="6" stroke="currentColor" strokeWidth="3" />
      <text
        x="16"
        y="22.5"
        textAnchor="middle"
        fontFamily="system-ui, -apple-system, sans-serif"
        fontSize="15"
        fontWeight="700"
        fill="currentColor"
      >
        bd
      </text>
    </svg>
  )
}

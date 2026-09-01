export function OdooIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      {/* Why: Odoo's mark is four circles spelling "odoo"; a single ring keeps
      the provider icon legible at 16px and matches Orca's monochrome set. */}
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 4.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z" />
    </svg>
  )
}

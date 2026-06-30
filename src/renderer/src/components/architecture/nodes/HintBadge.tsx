type Hint = {
  severity: 'info' | 'warning'
}

export function HintBadge({ hints }: { hints: Hint[] }): React.JSX.Element | null {
  if (hints.length === 0) {
    return null
  }
  const hasWarning = hints.some((hint) => hint.severity === 'warning')
  return (
    <div
      className={`absolute -right-1.5 -top-1.5 z-20 size-4 rounded-full border-2 border-background ${
        hasWarning ? 'bg-orange-400' : 'bg-teal-400'
      }`}
      title={`${hints.length} hint${hints.length > 1 ? 's' : ''}`}
      data-testid="architecture-hint-badge"
    />
  )
}

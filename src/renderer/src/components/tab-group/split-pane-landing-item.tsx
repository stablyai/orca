import { useEffect, useEffectEvent } from 'react'

/** Hide shortcuts on narrow cards so labels keep the room. */
export function LandingItemShortcut({ label }: { label: string | null }): React.JSX.Element | null {
  if (!label) {
    return null
  }
  return (
    <span className="ml-auto shrink-0 text-xs tracking-normal tabular-nums text-muted-foreground @max-[280px]:hidden">
      {label}
    </span>
  )
}

export function landingQueryMatches(label: string, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return needle === '' || label.toLowerCase().includes(needle)
}

/** Fires after a result group commits a different set of rows, never on a re-render that
 *  keeps them, so ↑↓ over stable results is left alone. */
export function useLandingResultsChange(ids: readonly string[], onChange: () => void): void {
  const key = ids.join('\n')
  const notify = useEffectEvent(onChange)
  useEffect(() => {
    notify()
  }, [key])
}

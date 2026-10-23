import { moreHostsLabel } from './host-picker-copy'

/** Says how many hosts a bounded list left out and that searching reaches them. */
export function HostListOverflowNote({
  hiddenCount
}: {
  hiddenCount: number
}): React.JSX.Element | null {
  if (hiddenCount <= 0) {
    return null
  }
  return (
    <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
      {moreHostsLabel(hiddenCount)}
    </div>
  )
}

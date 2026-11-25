import { moreHostsLabel } from './host-picker-copy'

export function HostListOverflowNote({
  hiddenCount,
  label = moreHostsLabel
}: {
  hiddenCount: number
  label?: (count: number) => string
}): React.JSX.Element | null {
  if (hiddenCount <= 0) {
    return null
  }
  return (
    <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
      {label(hiddenCount)}
    </div>
  )
}

import { Badge } from '@/components/ui/badge'

type TabHostBadgeAndColorProps = { hostBadge: string | null; color: string | null; hidden: boolean }

/** Host badge and colour swatch beside a tab label; hidden while the tab is being renamed. */
export function TabHostBadgeAndColor({
  hostBadge,
  color,
  hidden
}: TabHostBadgeAndColorProps): React.JSX.Element | null {
  if (hidden) {
    return null
  }
  return (
    <>
      {hostBadge ? (
        <Badge variant="hostContext" className="mr-1 min-w-0 max-w-1/2 shrink" title={hostBadge}>
          <span className="truncate">{hostBadge}</span>
        </Badge>
      ) : null}
      {color && (
        <span className="mr-1.5 size-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
      )}
    </>
  )
}

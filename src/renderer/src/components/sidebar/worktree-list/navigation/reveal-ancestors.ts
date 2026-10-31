import type { HeaderRevealPlacement } from '../../../../../../shared/sidebar-list/header-reveal-placement'

export function getSidebarRowRevealAncestorKeys(args: {
  rowKey: string
  headerRevealPlacements?: ReadonlyMap<string, HeaderRevealPlacement>
}): string[] {
  const placement = args.headerRevealPlacements?.get(args.rowKey)
  const keys: string[] = []
  const seen = new Set<string>()
  let path = placement?.parent
  while (path && !seen.has(path.key)) {
    seen.add(path.key)
    keys.unshift(path.key)
    path = path.parent
  }
  if (placement?.hostKey) {
    keys.unshift(placement.hostKey)
  }
  return keys
}

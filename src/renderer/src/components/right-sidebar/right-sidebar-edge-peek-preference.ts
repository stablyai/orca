import type { GlobalSettings } from '../../../../shared/types'

/** Absent means on: edge peek is default-enabled for legacy profiles. */
export function isRightSidebarEdgePeekEnabled(
  settings: Pick<GlobalSettings, 'rightSidebarEdgePeekEnabled'> | null | undefined
): boolean {
  return settings?.rightSidebarEdgePeekEnabled !== false
}

export function isRightSidebarEdgePeekTipDismissed(
  settings: Pick<GlobalSettings, 'rightSidebarEdgePeekTipDismissed'> | null | undefined
): boolean {
  return settings?.rightSidebarEdgePeekTipDismissed === true
}

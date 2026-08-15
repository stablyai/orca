/**
 * True when a refresh dropped every selected automation while full-page detail is open —
 * without closing, detail silently re-renders whichever automation the list now sorts first.
 */
export function shouldCloseDetailForLostSelection({
  isDetailOpen,
  hasPendingNavigation,
  isSelectedAutomationInNextList,
  isSelectedExternalInNextList
}: {
  isDetailOpen: boolean
  hasPendingNavigation: boolean
  isSelectedAutomationInNextList: boolean
  isSelectedExternalInNextList: boolean
}): boolean {
  if (!isDetailOpen || hasPendingNavigation) {
    return false
  }
  return !isSelectedAutomationInNextList && !isSelectedExternalInNextList
}

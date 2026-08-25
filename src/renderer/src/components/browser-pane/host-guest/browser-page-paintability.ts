export type BrowserPagePaintabilityState = {
  isActive: boolean
  isAutomationVisible: boolean
  isMobileDriven: boolean
}

export function isBrowserPagePanePaintable({
  isActive,
  isAutomationVisible,
  isMobileDriven
}: BrowserPagePaintabilityState): boolean {
  return isActive || isAutomationVisible || isMobileDriven
}

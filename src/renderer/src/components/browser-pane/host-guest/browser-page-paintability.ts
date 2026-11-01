export type BrowserPagePaintabilityState = {
  isActive: boolean
  isAutomationVisible: boolean
  isMobileDriven: boolean
  // Paired viewers take no presence lock; their own term prevents display:none from stopping the stream.
  hasRemoteViewer: boolean
}

export function isBrowserPagePanePaintable({
  isActive,
  isAutomationVisible,
  isMobileDriven,
  hasRemoteViewer
}: BrowserPagePaintabilityState): boolean {
  return isActive || isAutomationVisible || isMobileDriven || hasRemoteViewer
}

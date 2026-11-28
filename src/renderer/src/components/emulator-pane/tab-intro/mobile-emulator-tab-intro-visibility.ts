export type MobileEmulatorTabIntroVisibilityInput = {
  persistedUIReady: boolean
  mobileEmulatorTabIntroDismissed: boolean
  mobileEmulatorEnabled: boolean
  isMacOs: boolean
}

export function shouldShowMobileEmulatorTabIntro({
  persistedUIReady,
  mobileEmulatorTabIntroDismissed,
  mobileEmulatorEnabled,
  isMacOs
}: MobileEmulatorTabIntroVisibilityInput): boolean {
  return persistedUIReady && isMacOs && mobileEmulatorEnabled && !mobileEmulatorTabIntroDismissed
}

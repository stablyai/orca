export function canUseViewerWindowsRuntimeSettings(
  isWebClient: boolean,
  wslSupportedPlatform: boolean
): boolean {
  return !isWebClient && wslSupportedPlatform
}

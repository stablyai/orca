export type MacosUpgradeSupport = {
  macos13: 'supported' | 'unsupported' | 'unknown'
  modelIdentifier: string | null
}

export function isMacos12SupportNoticeEligible(
  platform: { platform: string; osRelease: string },
  webClient: boolean
): boolean {
  // The preload exposes getSystemVersion(), not the Darwin kernel release.
  return !webClient && platform.platform === 'darwin' && /^12(?:\.|$)/u.test(platform.osRelease)
}

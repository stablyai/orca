import type { StatusBarItem } from '../../../../shared/types'

export function isStatusBarItemSupportedOnPlatform(
  id: StatusBarItem,
  platform: NodeJS.Platform
): boolean {
  return id !== 'media-playback' || platform === 'darwin'
}

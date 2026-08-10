import { translate } from '@/i18n/i18n'

/** Platform-appropriate “reveal in OS file manager” label for menus. */
export function getOsRevealLabel(
  platform: NodeJS.Platform | 'mac' | 'linux' | 'windows' = detectRevealPlatform()
): string {
  if (platform === 'darwin' || platform === 'mac') {
    return translate('auto.components.osReveal.revealInFinder', 'Reveal in Finder')
  }
  if (platform === 'linux') {
    return translate('auto.components.osReveal.openContainingFolder', 'Open Containing Folder')
  }
  return translate('auto.components.osReveal.revealInFileExplorer', 'Reveal in File Explorer')
}

function detectRevealPlatform(): 'mac' | 'linux' | 'windows' {
  if (typeof navigator === 'undefined') {
    return 'windows'
  }
  if (navigator.userAgent.includes('Mac')) {
    return 'mac'
  }
  if (navigator.userAgent.includes('Linux')) {
    return 'linux'
  }
  return 'windows'
}

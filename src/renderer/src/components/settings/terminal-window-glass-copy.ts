import { translate } from '@/i18n/i18n'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { isWebClientLocation } from '@/lib/web-client-location'

export type GlassCopyPlatform = 'mac' | 'windows' | 'linux' | 'web'

/** One gate for the glass control, its copy, and its search entry. */
export function getGlassCopyPlatform(
  platform: NodeJS.Platform = getRendererAppPlatform(),
  isWebClient: boolean = isWebClientLocation()
): GlassCopyPlatform {
  // Why: a browser web client reports the browser's OS but never owns a glass window.
  if (isWebClient) {
    return 'web'
  }
  if (platform === 'darwin') {
    return 'mac'
  }
  return platform === 'win32' ? 'windows' : 'linux'
}

const KEY = 'auto.components.settings.TerminalWindowSection.glass'

export function windowBlurDescription(platform: GlassCopyPlatform): string {
  if (platform === 'mac') {
    return translate(
      `${KEY}.blurMac`,
      'Frosted-glass desktop behind terminals and the chat UI; Interface Glass extends it to the rest of the window. Tune it with Background Opacity and Chat Glass Opacity. Uses some extra GPU power. Requires restart.'
    )
  }
  if (platform === 'windows') {
    return translate(
      `${KEY}.blurWindows`,
      "Requests the Windows 11 acrylic backdrop. Orca's panels stay opaque on Windows, so terminals and chat don't show it yet. Requires restart."
    )
  }
  if (platform === 'web') {
    return translate(
      `${KEY}.blurWeb`,
      'Applies to the Orca desktop app window; it has no effect in this browser.'
    )
  }
  return translate(`${KEY}.blurLinux`, 'Not available on Linux.')
}

export function backgroundOpacityDescription(platform: GlassCopyPlatform): string {
  if (platform === 'mac') {
    return translate(
      `${KEY}.opacityMac`,
      "Terminal background opacity, 1 is solid. With Window Blur on, lower values show the blurred desktop; with it off, they only blend into Orca's own background."
    )
  }
  return translate(
    `${KEY}.opacityOther`,
    "Terminal background opacity, 1 is solid. Orca's window is opaque on this platform, so lower values blend into Orca's own background instead of showing the desktop."
  )
}

export function chatGlassOpacityDescription(blurEnabled: boolean): string {
  return blurEnabled
    ? translate(
        `${KEY}.chatOpacity`,
        'Chat UI background opacity over the blurred desktop, 1 is solid. Lower values show more of the desktop.'
      )
    : translate(`${KEY}.chatOpacityNeedsBlur`, 'Turn on Window Blur (and restart) to use this.')
}

export function terminalChatGlassDescription(blurEnabled: boolean): string {
  return blurEnabled
    ? translate(
        `${KEY}.terminalChatGlass`,
        'Tint terminals with the chat glass color and Chat Glass Opacity instead of the terminal theme background and Background Opacity.'
      )
    : translate(`${KEY}.chatOpacityNeedsBlur`, 'Turn on Window Blur (and restart) to use this.')
}

export function interfaceGlassDescription(blurEnabled: boolean): string {
  return blurEnabled
    ? translate(
        `${KEY}.interface`,
        'Also show the blurred desktop through the sidebars, tab bar, status bar, and full pages such as Settings. Editors and dialogs stay solid.'
      )
    : translate(
        `${KEY}.interfaceNeedsBlur`,
        'Turn on Window Blur (and restart) to use this. Extends the glass to the sidebars, tab bar, status bar, and full pages.'
      )
}

export function interfaceGlassOpacityDescription(
  blurEnabled: boolean,
  interfaceGlass: boolean
): string {
  if (!blurEnabled) {
    return translate(
      `${KEY}.chatOpacityNeedsBlur`,
      'Turn on Window Blur (and restart) to use this.'
    )
  }
  return interfaceGlass
    ? translate(
        `${KEY}.interfaceOpacity`,
        'Background opacity of the sidebars, tab bar, status bar, and full pages over the blurred desktop, 1 is solid.'
      )
    : translate(`${KEY}.interfaceOpacityNeedsToggle`, 'Turn on Interface Glass to use this.')
}

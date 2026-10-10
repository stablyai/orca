// Why transparent: false: Electron guests are transparent by default, so a page that paints no
// background of its own would show Orca's themed surface through it instead of a white canvas.
export const ORCA_BROWSER_GUEST_WEB_PREFERENCES = {
  disableHtmlFullscreenWindowResize: true,
  transparent: false
} as const

export const ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE =
  'disableHtmlFullscreenWindowResize=true,transparent=false'

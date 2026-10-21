export const ORCA_BROWSER_GUEST_WEB_PREFERENCES = {
  disableHtmlFullscreenWindowResize: true
} as const

export const ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE = 'disableHtmlFullscreenWindowResize=true'

/** Browser-page guests: an opaque page canvas, so a page without a background is white on the
 *  desktop under any theme and in its screencast (a transparent JPEG frame encodes as black). */
export const ORCA_BROWSER_PAGE_GUEST_WEB_PREFERENCES_ATTRIBUTE = `${ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE},transparent=false`

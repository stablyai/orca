/** Shift traditionally forces system browser; the inversion setting instead chooses the other destination when system is already default. */
export function resolveModifierRouting(
  modifierHeld: boolean,
  openLinksInApp: boolean,
  modifierInverts: boolean
): { wantsOrca: boolean; wantsSystemBrowser: boolean } {
  if (!modifierHeld) {
    return { wantsOrca: false, wantsSystemBrowser: false }
  }
  if (!modifierInverts) {
    return { wantsOrca: false, wantsSystemBrowser: true }
  }
  return { wantsOrca: !openLinksInApp, wantsSystemBrowser: openLinksInApp }
}

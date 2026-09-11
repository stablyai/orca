export function browserOverlayOwnsShortcutTarget(
  target: EventTarget | null,
  overlayTabId: string
): boolean {
  if (!(target instanceof Element)) {
    return false
  }
  return (
    target.closest('[data-browser-overlay-tab-id]')?.getAttribute('data-browser-overlay-tab-id') ===
    overlayTabId
  )
}

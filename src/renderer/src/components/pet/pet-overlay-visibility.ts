export function shouldRenderPetOverlay({
  persistedUIReady,
  petEnabled,
  petVisible
}: {
  persistedUIReady: boolean
  petEnabled: boolean
  petVisible: boolean
}): boolean {
  // Wait for persisted UI so default visibility cannot flash pets the user hid.
  return persistedUIReady && petEnabled && petVisible
}

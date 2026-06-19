export function shouldRenderPetOverlay({
  persistedUIReady,
  petEnabled,
  petVisible
}: {
  persistedUIReady: boolean
  petEnabled: boolean
  petVisible: boolean
}): boolean {
  // Why: petVisible defaults true until persisted UI hydrates. Waiting avoids
  // flashing the pet for users who previously hid it.
  return persistedUIReady && petEnabled && petVisible
}

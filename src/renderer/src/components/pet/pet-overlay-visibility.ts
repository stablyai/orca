export function shouldRenderPetOverlay({
  persistedUIReady,
  petEnabled,
  petVisible,
  petDetached
}: {
  persistedUIReady: boolean
  petEnabled: boolean
  petVisible: boolean
  petDetached: boolean
}): boolean {
  // Why: petVisible defaults true until persisted UI hydrates. Waiting avoids
  // flashing the pet for users who previously hid it.
  // Why: a detached pet lives in its own window — drawing it here too would double it.
  return persistedUIReady && petEnabled && petVisible && !petDetached
}

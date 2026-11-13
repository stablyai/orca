export async function runQuickWorkspaceCreation(
  inFlight: { current: boolean },
  setInFlight: (value: boolean) => void,
  create: () => Promise<void>
): Promise<void> {
  inFlight.current = true
  setInFlight(true)
  try {
    await create()
  } finally {
    inFlight.current = false
    setInFlight(false)
  }
}

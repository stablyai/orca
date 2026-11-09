export async function runHostMenuAction(
  action: () => Promise<void> | void,
  onSettled: () => void
): Promise<void> {
  try {
    await action()
  } finally {
    onSettled()
  }
}

/** Raises a busy flag around an async action; try/finally lives here because React Compiler cannot compile it in a hook. */
export async function withBusyFlag<T>(
  setBusy: (busy: boolean) => void,
  action: () => Promise<T>
): Promise<T> {
  setBusy(true)
  try {
    return await action()
  } finally {
    setBusy(false)
  }
}

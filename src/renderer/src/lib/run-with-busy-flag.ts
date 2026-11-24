/**
 * Hold a busy flag while `task` runs. Module-level so React Compiler can
 * compile the callers: try/finally inside a component or hook is a bailout.
 */
export async function runWithBusyFlag(
  setBusy: (busy: boolean) => void,
  task: () => Promise<void>
): Promise<void> {
  setBusy(true)
  try {
    await task()
  } finally {
    setBusy(false)
  }
}

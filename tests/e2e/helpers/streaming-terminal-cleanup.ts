export async function closeStreamingTerminals(
  terminals: string[],
  call: (method: 'terminal.closeTab' | 'terminal.close', terminal: string) => Promise<unknown>
): Promise<void> {
  const results = await Promise.allSettled(
    terminals.map(async (terminal) => {
      try {
        await call('terminal.closeTab', terminal)
      } catch (closeTabError) {
        try {
          await call('terminal.close', terminal)
        } catch (closeError) {
          throw new AggregateError(
            [closeTabError, closeError],
            `Failed to close streaming terminal ${terminal}`
          )
        }
      }
    })
  )
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  )
  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed to close ${failures.length} streaming terminal(s)`)
  }
}

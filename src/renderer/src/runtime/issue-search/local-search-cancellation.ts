import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/identifiers/non-secure-context-uuid'

type LocalSearchCancellation<T> = {
  providerLabel: string
  signal: AbortSignal
  search: (requestId: string) => Promise<T>
  cancel: (requestId: string) => Promise<unknown>
}

function createSearchAbortError(providerLabel: string): Error {
  const error = new Error(`${providerLabel} search aborted`)
  error.name = 'AbortError'
  return error
}

/** Cancel superseded local searches in main or abandoned keystrokes hold shared provider pool slots and stall the next query. */
export async function searchLocalWithCancellation<T>({
  providerLabel,
  signal,
  search,
  cancel
}: LocalSearchCancellation<T>): Promise<T> {
  if (signal.aborted) {
    throw createSearchAbortError(providerLabel)
  }
  const requestId = createBrowserUuid()
  const handleAbort = (): void => {
    void cancel(requestId).catch(() => {})
  }
  signal.addEventListener('abort', handleAbort, { once: true })
  try {
    const result = await search(requestId)
    // Why: cancel can race ahead of main-process registration; drop late successes.
    if (signal.aborted) {
      throw createSearchAbortError(providerLabel)
    }
    return result
  } finally {
    signal.removeEventListener('abort', handleAbort)
  }
}

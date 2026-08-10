export function createTextSearchAbortError(): Error {
  const error = new Error('Text search aborted')
  error.name = 'AbortError'
  return error
}

export function throwIfTextSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createTextSearchAbortError()
  }
}

/** Extract a useful message from either an Error or a JSON RPC error payload. */
export function structuredAgentSessionErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  if (typeof error === 'object' && error !== null) {
    const record = error as { code?: unknown; message?: unknown }
    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message
    }
    if (typeof record.code === 'string' && record.code.trim()) {
      return record.code
    }
    try {
      const serialized = JSON.stringify(error)
      if (serialized) {
        return serialized
      }
    } catch {
      // Fall through to the primitive coercion below.
    }
  }
  return String(error)
}

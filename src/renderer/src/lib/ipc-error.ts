// Unanchored so caller-owned context around an Electron wrapper survives.
const IPC_INVOKE_PREFIX = /Error invoking remote method '[^']*':\s*(?:Error:\s*)?/
const IPC_HANDLER_PREFIX = /Error occurred in handler for '[^']*':\s*(?:Error:\s*)?/

export function readIpcErrorDetail(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined
  }
  const message = error.message
    .replace(IPC_INVOKE_PREFIX, '')
    .replace(IPC_HANDLER_PREFIX, '')
    .trim()
  return message || undefined
}

export function readIpcErrorMessage(error: unknown): string | undefined {
  return readIpcErrorDetail(error)?.split('\n')[0]?.trim() || undefined
}

// Preserve the legacy contract: wrapped errors are compact, while plain errors retain detail.
export function extractIpcErrorMessage(err: unknown, fallback: string): string {
  const detail = readIpcErrorDetail(err)
  if (!detail) {
    return fallback
  }
  const wrapped =
    err instanceof Error &&
    (IPC_INVOKE_PREFIX.test(err.message) || IPC_HANDLER_PREFIX.test(err.message))
  return wrapped ? detail.split('\n')[0]?.trim() || fallback : detail
}

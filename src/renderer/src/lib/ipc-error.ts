// Unanchored so caller-owned context around an Electron wrapper survives.
const IPC_INVOKE_PREFIX = /Error invoking remote method '[^']*':\s*(?:Error:\s*)?/
const IPC_HANDLER_PREFIX = /Error occurred in handler for '[^']*':\s*(?:Error:\s*)?/
// Remove unwrapped main-process class names so they cannot push actionable text off the toast’s first line (#19334).
const ERROR_CLASS_PREFIX = /^(?:[A-Za-z_$][\w$]*)?Error:\s*/

function unwrapIpcErrorMessage(message: string): string | undefined {
  const wrapped = IPC_INVOKE_PREFIX.test(message) || IPC_HANDLER_PREFIX.test(message)
  const detail = message.replace(IPC_INVOKE_PREFIX, '').replace(IPC_HANDLER_PREFIX, '').trim()
  // Strip class names only from unwrapped main errors; preserve local TypeError identity.
  return (wrapped ? detail.replace(ERROR_CLASS_PREFIX, '').trim() : detail) || undefined
}

export function compactIpcErrorMessage(message: string): string | undefined {
  return unwrapIpcErrorMessage(message)?.split('\n')[0]?.trim() || undefined
}
export function readIpcErrorDetail(error: unknown): string | undefined {
  return error instanceof Error ? unwrapIpcErrorMessage(error.message) : undefined
}

export function readIpcErrorMessage(error: unknown): string | undefined {
  return error instanceof Error ? compactIpcErrorMessage(error.message) : undefined
}

// Preserve the legacy contract: wrapped errors are compact, while plain errors retain detail.
export function extractIpcErrorMessage(err: unknown, fallback: string): string {
  return (err instanceof Error ? displayIpcErrorMessage(err.message) : undefined) ?? fallback
}

export function displayIpcErrorMessage(message: string): string | undefined {
  const detail = unwrapIpcErrorMessage(message)
  if (!detail) {
    return undefined
  }
  const wrapped = IPC_INVOKE_PREFIX.test(message) || IPC_HANDLER_PREFIX.test(message)
  return wrapped ? detail.split('\n')[0]?.trim() || undefined : detail
}

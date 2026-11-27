// Read failures arrive as "<code>: …", possibly behind Electron's "Error invoking remote method" prefix.
export function isItsaplanInvalidApiKeyError(message: string | null | undefined): boolean {
  return Boolean(message && /(^|[\s:])invalidApiKey:/.test(message))
}

export function getItsaplanErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

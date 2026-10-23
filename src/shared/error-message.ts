/** The message of a thrown value, which may not be an Error. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

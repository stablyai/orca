/** Convert an unknown thrown value into the message used by existing error surfaces. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

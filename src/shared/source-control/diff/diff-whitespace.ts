/** Diffs hide leading/trailing-whitespace-only changes unless the user turned whitespace on. */
export function shouldIgnoreTrimWhitespace(diffShowWhitespace: boolean | undefined): boolean {
  return diffShowWhitespace !== true
}

/** Keep input inserted while a submitted snapshot was in flight; other edits keep the whole draft. */
export function textLeftAfterSubmission(
  current: string,
  submitted: string
): { text: string; from: number; to: number } | null {
  let from = 0
  while (from < submitted.length && submitted[from] === current[from]) {
    from++
  }
  const rest = submitted.slice(from)
  if (current.length < submitted.length || !current.endsWith(rest)) {
    return null
  }
  const to = current.length - rest.length
  return { text: current.slice(from, to), from, to }
}

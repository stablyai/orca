/** A positive, safe issue / PR / MR number from a bare or `#`-prefixed digit
 *  string. One owner: GitHub links, GitLab links and the meta dialog all agreed
 *  on this shape and disagreed only on the safe-integer bound. */
export function parseBareItemNumber(input: string): number | null {
  const digits = input.startsWith('#') ? input.slice(1) : input
  if (!/^\d+$/.test(digits)) {
    return null
  }
  const parsed = Number.parseInt(digits, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/** Ids at or under this length fit the 72px ID column on one line (GitHub `#12345` scale). */
const BEADS_ID_WRAP_MIN_LENGTH = 8

/**
 * Long bd ids (`<prefix>-<hash>`, children `<hash>.<n>`) read better wrapped at
 * the last hyphen than truncated. Returns [head-with-hyphen, tail], or null
 * when the id is short enough for one line or has no interior hyphen.
 */
export function splitBeadsIssueIdForWrap(id: string): [string, string] | null {
  if (id.length < BEADS_ID_WRAP_MIN_LENGTH) {
    return null
  }
  const breakAt = id.lastIndexOf('-')
  if (breakAt <= 0 || breakAt >= id.length - 1) {
    return null
  }
  return [id.slice(0, breakAt + 1), id.slice(breakAt + 1)]
}

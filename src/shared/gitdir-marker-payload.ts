/**
 * The path payload of a Git `.git` gitfile marker, or null when the file carries none.
 *
 * Why the shape: git's own read_gitfile_gently only accepts the `gitdir:` marker at the start of the
 * file and strips whitespace around the payload, so a `gitdir:` line further down is not a marker
 * and padding is not part of the path. `.` never matches a newline, which is what keeps the match on
 * the first line.
 */
export function parseGitdirMarkerPayload(content: string): string | null {
  return content.match(/^gitdir:(.*)/i)?.[1].trim() || null
}

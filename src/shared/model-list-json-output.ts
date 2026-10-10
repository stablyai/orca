/** The outermost JSON object in a CLI's stdout, or null when none parses.
 *  Why: an update notice or extension warning can precede the JSON on stdout;
 *  the listing itself is the outermost object. */
export function parseModelListJsonObject(stdout: string): unknown {
  const trimmed = stdout.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start === -1 || end <= start) {
      return null
    }
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return null
    }
  }
}

const ASCII_PADDING = ' \t\v\f\r'

/** Match Git read_gitfile_gently: gitdir: must start the file and only the first line counts. Strip ASCII padding only, like the WSL shell parser, so both name one marker the same way. */
export function parseGitdirMarkerPayload(content: string): string | null {
  const payload = content.match(/^gitdir:([^\n]*)/i)?.[1]
  if (payload === undefined) {
    return null
  }
  // Index scan, not a regex: a long interior whitespace run must stay linear on listing paths.
  let start = 0
  let end = payload.length
  while (start < end && ASCII_PADDING.includes(payload[start])) {
    start += 1
  }
  while (end > start && ASCII_PADDING.includes(payload[end - 1])) {
    end -= 1
  }
  return payload.slice(start, end) || null
}

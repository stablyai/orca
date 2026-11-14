/** Match Git read_gitfile_gently: gitdir: must start the file, payload padding is stripped, and dot excludes newlines so later lines cannot match. */
export function parseGitdirMarkerPayload(content: string): string | null {
  return content.match(/^gitdir:(.*)/i)?.[1].trim() || null
}

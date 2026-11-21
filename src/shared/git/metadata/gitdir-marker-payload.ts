/** Match Git read_gitfile_gently: gitdir: must start the file and only the first line counts. Strip ASCII padding only, like the WSL shell parser, so both name one marker the same way. */
export function parseGitdirMarkerPayload(content: string): string | null {
  const payload = content.match(/^gitdir:([^\n]*)/i)?.[1]
  return payload?.replace(/^[ \t\v\f\r]+|[ \t\v\f\r]+$/g, '') || null
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

// GitLab matches a diff note on both coordinates, so an unchanged line needs its old number too.
export function getGitLabContextLineOldNumber(
  diff: string | undefined,
  line: number
): number | undefined {
  const rows = diff?.split('\n') ?? []
  if (rows.at(-1) === '') {
    rows.pop()
  }
  let oldLine: number | null = null
  let newLine = 0
  for (const row of rows) {
    const hunk = HUNK_HEADER_RE.exec(row)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
    } else if (oldLine === null || row.startsWith('\\')) {
      continue
    } else if (row.startsWith('+')) {
      newLine++
    } else if (row.startsWith('-')) {
      oldLine++
    } else {
      if (newLine === line) {
        return oldLine
      }
      oldLine++
      newLine++
    }
  }
  return undefined
}

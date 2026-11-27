// GitLab needs both coordinates for context lines; added lines must omit old_line.
export function getGitLabContextLineOldNumber(
  diff: string | undefined,
  line: number
): number | undefined {
  if (!diff || !Number.isSafeInteger(line) || line <= 0) {
    return undefined
  }
  let oldLine = 0
  let newLine = 0
  let oldRemaining = 0
  let newRemaining = 0
  let cursor = 0
  while (cursor < diff.length) {
    const newline = diff.indexOf('\n', cursor)
    const end = newline === -1 ? diff.length : newline
    const row = diff.slice(cursor, end)
    cursor = end + 1
    if (row.startsWith('@@')) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row)
      oldLine = Number(hunk?.[1] ?? 0)
      newLine = Number(hunk?.[3] ?? 0)
      oldRemaining = hunk ? Number(hunk[2] ?? 1) : 0
      newRemaining = hunk ? Number(hunk[4] ?? 1) : 0
      if (
        !Number.isSafeInteger(oldLine + oldRemaining) ||
        !Number.isSafeInteger(newLine + newRemaining) ||
        (oldRemaining > 0 && oldLine === 0) ||
        (newRemaining > 0 && newLine === 0)
      ) {
        oldRemaining = 0
        newRemaining = 0
      }
      continue
    }
    if (row.startsWith('\\')) {
      continue
    }
    const prefix = row[0]
    const oldStep = prefix === '+' ? 0 : 1
    const newStep = prefix === '-' ? 0 : 1
    if (
      (prefix !== ' ' && prefix !== '+' && prefix !== '-') ||
      oldRemaining < oldStep ||
      newRemaining < newStep
    ) {
      oldRemaining = 0
      newRemaining = 0
      continue
    }
    if (prefix === ' ' && newLine === line) {
      return oldLine
    }
    oldLine += oldStep
    newLine += newStep
    oldRemaining -= oldStep
    newRemaining -= newStep
  }
  return undefined
}

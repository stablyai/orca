type GitStatusLineStatEntry = {
  area?: unknown
  path?: unknown
}

export type GitStatusLineStatInputs = {
  hasStaged: boolean
  hasUnstaged: boolean
  untrackedPaths: string[]
}

export function collectGitStatusLineStatInputs(
  entries: readonly GitStatusLineStatEntry[]
): GitStatusLineStatInputs {
  let hasStaged = false
  let hasUnstaged = false
  const untrackedPaths: string[] = []

  for (const entry of entries) {
    const area = entry.area
    if (area === 'staged') {
      hasStaged = true
    } else if (area === 'unstaged') {
      hasUnstaged = true
    } else if (area === 'untracked') {
      untrackedPaths.push(entry.path as string)
    }
  }

  return { hasStaged, hasUnstaged, untrackedPaths }
}

type GitStatusLineStatEntry = {
  area?: unknown
  path?: unknown
  status?: unknown
}

export type GitStatusLineStatInputs = {
  hasStaged: boolean
  hasUnstaged: boolean
  hasStagedRenames: boolean
  hasUnstagedRenames: boolean
  untrackedPaths: string[]
}

export function collectGitStatusLineStatInputs(
  entries: readonly GitStatusLineStatEntry[]
): GitStatusLineStatInputs {
  let hasStaged = false
  let hasUnstaged = false
  let hasStagedRenames = false
  let hasUnstagedRenames = false
  const untrackedPaths: string[] = []

  for (const entry of entries) {
    const area = entry.area
    if (area === 'staged') {
      hasStaged = true
      hasStagedRenames ||= entry.status === 'renamed'
    } else if (area === 'unstaged') {
      hasUnstaged = true
      hasUnstagedRenames ||= entry.status === 'renamed'
    } else if (area === 'untracked') {
      untrackedPaths.push(entry.path as string)
    }
  }

  return { hasStaged, hasUnstaged, hasStagedRenames, hasUnstagedRenames, untrackedPaths }
}

import type { GitBranchChangeEntry } from './git-diff-compare-types'
import type { GitBranchChangeStatus } from './git-status-types'
import { parseNumstat } from './git-uncommitted-line-stats'

const CHANGE_STATUS: Record<string, GitBranchChangeStatus> = {
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied'
}

export function gitChangeListArgs(fromOid: string | null, toOid: string): string[] {
  const format = ['--raw', '--numstat', '-z', '-M', '-C']
  return fromOid
    ? ['diff', ...format, fromOid, toOid, '--']
    : ['diff-tree', '--root', '--no-commit-id', '-r', ...format, toOid, '--']
}

export function parseGitChangeList(
  stdout: string,
  format: 'raw' | 'name-status' = 'raw'
): GitBranchChangeEntry[] {
  const entries: GitBranchChangeEntry[] = []
  let offset = 0
  function readField(): string {
    const end = stdout.indexOf('\0', offset)
    if (end === -1) {
      throw new Error('Incomplete Git change record')
    }
    const value = stdout.slice(offset, end)
    offset = end + 1
    return value
  }

  // Raw records precede numstat records; filenames are separate NUL-delimited fields.
  while (offset < stdout.length && (format === 'name-status' || stdout[offset] === ':')) {
    const header = readField()
    const match =
      format === 'name-status'
        ? /^([A-Z])\d*$/.exec(header)
        : /^:[0-7]{6} [0-7]{6} [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(header)
    if (!match) {
      throw new Error('Invalid Git change record')
    }
    const code = match[1] ?? ''
    const firstPath = readField()
    const oldPath = code === 'R' || code === 'C' ? firstPath : undefined
    const path = oldPath === undefined ? firstPath : readField()
    if (!path || oldPath === '') {
      throw new Error('Missing Git change path')
    }
    entries.push({
      path,
      status: CHANGE_STATUS[code] ?? 'modified',
      ...(oldPath === undefined ? {} : { oldPath })
    })
  }
  if (offset === stdout.length) {
    return entries
  }
  const statsByPath = parseNumstat(stdout.slice(offset))
  return entries.map((entry) => ({ ...entry, ...statsByPath.get(entry.path) }))
}

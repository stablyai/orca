import { access } from 'node:fs/promises'
import * as path from 'node:path'
import type { GitConflictKind, GitFileStatus, GitStatusEntry } from './git-status-types'
import { decodeGitCQuotedPath } from './git-cquoted-path'

export async function parseUnmergedEntry(
  worktreePath: string,
  line: string
): Promise<GitStatusEntry | null> {
  // Why: porcelain v2 `u` records are space-separated (not tab); path is field 10+ and may contain spaces, so join the tail.
  const parts = line.split(' ')
  const xy = parts[1]
  const modeStage1 = parts[3]
  const modeStage2 = parts[4]
  const modeStage3 = parts[5]
  const filePath = decodeGitCQuotedPath(parts.slice(10).join(' '))
  if (!filePath) {
    return null
  }

  // Why: submodule conflicts (mode 160000) are out of scope for v1 — they need different resolution UX.
  if ([modeStage1, modeStage2, modeStage3].some((mode) => mode === '160000')) {
    return null
  }

  const conflictKind = parseConflictKind(xy)
  if (!conflictKind) {
    return null
  }

  // Why: porcelain v2 `u` records lack rename-origin metadata, so oldPath is intentionally omitted.
  return {
    path: filePath,
    area: 'unstaged',
    status: await getConflictCompatibilityStatus(worktreePath, filePath, conflictKind),
    conflictKind,
    conflictStatus: 'unresolved'
  }
}

function parseConflictKind(xy: string): GitConflictKind | null {
  switch (xy) {
    case 'UU':
      return 'both_modified'
    case 'AA':
      return 'both_added'
    case 'DD':
      return 'both_deleted'
    case 'AU':
      return 'added_by_us'
    case 'UA':
      return 'added_by_them'
    case 'DU':
      return 'deleted_by_us'
    case 'UD':
      return 'deleted_by_them'
    default:
      return null
  }
}

// Why: `status` here is a rendering-compat choice for icon/color plumbing, not semantic; the conflict badge carries the real meaning.
// Why: for deleted_by_*/added_by_* variants Git's result depends on merge strategy, so check the filesystem.
async function getConflictCompatibilityStatus(
  worktreePath: string,
  filePath: string,
  conflictKind: GitConflictKind
): Promise<GitFileStatus> {
  if (conflictKind === 'both_modified' || conflictKind === 'both_added') {
    return 'modified'
  }

  if (conflictKind === 'both_deleted') {
    return 'deleted'
  }

  // Why async: on a WSL worktree this path is a `\\wsl.localhost\...` share, and a sync probe
  // per asymmetric conflict blocks the Electron main thread for a 9p round trip each.
  try {
    await access(path.join(worktreePath, filePath))
    return 'modified'
  } catch (error) {
    // Why: only a definite "not there" reads as deleted; any other fs failure keeps the row visible
    // rather than falsely showing 'deleted'.
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'deleted' : 'modified'
  }
}

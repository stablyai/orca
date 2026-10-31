import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { waitForPromiseWithSignal } from './abort-signal-reason'
import {
  isMissingGitAdminEntry,
  readGitAdminFile,
  resolveGitCommonDirectory,
  type GitAdminReadOptions
} from './git-common-directory'
import { resolveGitMetadataPath } from './git-metadata-path'
import { mapWithConcurrency } from './map-with-concurrency'
import { foldWslUncPathCaseInsensitiveParts } from './wsl-paths'

export const ADMIN_READ_CONCURRENCY = 8
type WorktreeAdminDirectory = {
  gitDir: string
  gitFilePath?: string
  worktreePath?: string
  isMain?: true
}

export function hostPathKey(value: string): string {
  const normalized = path.resolve(value)
  return (
    foldWslUncPathCaseInsensitiveParts(normalized) ??
    (process.platform === 'win32' ? normalized.toLowerCase() : normalized)
  )
}

export async function readWorktreeAdminDirectories(
  repoPath: string,
  options: GitAdminReadOptions,
  requireDirectDirectories = false
): Promise<WorktreeAdminDirectory[]> {
  const commonDir = await resolveGitCommonDirectory(repoPath, options)
  if (!commonDir) {
    throw new Error('Cannot read Git worktree administrative directory.')
  }
  const adminDir = path.join(commonDir, 'worktrees')
  let entries: Dirent[]
  try {
    entries = await waitForPromiseWithSignal(
      readdir(adminDir, { withFileTypes: true }),
      options.signal
    )
  } catch (error) {
    if (isMissingGitAdminEntry(error)) {
      return [{ gitDir: commonDir, isMain: true }]
    }
    throw error
  }
  if (requireDirectDirectories && entries.some((entry) => entry.isSymbolicLink())) {
    throw new Error('Cannot verify linked worktree administration.')
  }
  const linked = await mapWithConcurrency(
    entries.filter((entry) => entry.isDirectory()),
    ADMIN_READ_CONCURRENCY,
    async (entry): Promise<WorktreeAdminDirectory> => {
      const gitDir = path.join(adminDir, entry.name)
      const gitdir = await readGitAdminFile(path.join(gitDir, 'gitdir'), options.signal)
      const target = gitdir && resolveGitMetadataPath(gitDir, gitdir, options)
      return {
        gitDir,
        ...(target ? { gitFilePath: target, worktreePath: path.dirname(target) } : {})
      }
    }
  )
  return [{ gitDir: commonDir, isMain: true }, ...linked]
}

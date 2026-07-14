import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type LargeFileCountRepoOptions = {
  /** Files committed on the initial commit. */
  trackedFiles?: number
  /** Files written after the commit and left untracked. */
  untrackedFiles?: number
  /** Tracked files rewritten after the commit (unstaged modifications). */
  modifiedFiles?: number
  /** Fan-out per directory; issue #8013 repos are wide trees, not one flat dir. */
  filesPerDirectory?: number
  /**
   * Minimum size of each untracked file. Untracked line stats read full file
   * contents (mtime-cached), so per-poll I/O cost only shows up when
   * untracked files have realistic sizes.
   */
  untrackedFileBytes?: number
}

export type LargeFileCountRepo = {
  repoPath: string
  trackedFiles: number
  untrackedFiles: number
  modifiedFiles: number
}

function runGit(repoPath: string, args: string[]): void {
  execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' })
}

/**
 * Removes a fixture repo, retrying ENOTEMPTY/EBUSY races: the app's git status
 * poll can still be writing index.lock (or the watcher holding dirs) while the
 * test tears down.
 */
export async function removeLargeFileCountRepo(repoPath: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(repoPath, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 4) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
    }
  }
}

function writeFileTree(
  repoPath: string,
  rootDirName: string,
  fileCount: number,
  filesPerDirectory: number,
  contentForIndex: (index: number) => string
): void {
  let currentDir: string | null = null
  for (let index = 0; index < fileCount; index += 1) {
    const dirIndex = Math.floor(index / filesPerDirectory)
    const dirPath = path.join(repoPath, rootDirName, `dir-${String(dirIndex).padStart(4, '0')}`)
    if (dirPath !== currentDir) {
      mkdirSync(dirPath, { recursive: true })
      currentDir = dirPath
    }
    writeFileSync(
      path.join(dirPath, `file-${String(index).padStart(6, '0')}.ts`),
      contentForIndex(index)
    )
  }
}

/**
 * Repro fixture for issue #8013: a repo whose file count (tracked, untracked,
 * or modified) is large enough to stress every per-file code path — the
 * streamed `git status` scan, per-entry line stats, the IPC payload, and the
 * Source Control row rendering.
 */
export function createLargeFileCountRepo(
  options: LargeFileCountRepoOptions = {}
): LargeFileCountRepo {
  const trackedFiles = options.trackedFiles ?? 0
  const untrackedFiles = options.untrackedFiles ?? 0
  const modifiedFiles = Math.min(options.modifiedFiles ?? 0, trackedFiles)
  const filesPerDirectory = options.filesPerDirectory ?? 100

  const repoPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-large-file-count-')))
  runGit(repoPath, ['init'])
  runGit(repoPath, ['config', 'user.email', 'e2e@test.local'])
  runGit(repoPath, ['config', 'user.name', 'E2E Test'])
  runGit(repoPath, ['config', 'core.autocrlf', 'false'])

  writeFileSync(path.join(repoPath, 'README.md'), '# Large file count fixture\n')
  writeFileTree(
    repoPath,
    'src',
    trackedFiles,
    filesPerDirectory,
    (index) => `export const tracked${index} = ${index}\n`
  )
  runGit(repoPath, ['add', '-A'])
  runGit(repoPath, ['commit', '-m', 'Initial large file count fixture', '--quiet'])

  const untrackedFileBytes = options.untrackedFileBytes ?? 0
  const untrackedPadding =
    untrackedFileBytes > 0
      ? `// ${'x'.repeat(78)}\n`.repeat(Math.ceil(untrackedFileBytes / 81))
      : ''
  writeFileTree(
    repoPath,
    'generated',
    untrackedFiles,
    filesPerDirectory,
    (index) => `export const untracked${index} = ${index}\n${untrackedPadding}`
  )

  for (let index = 0; index < modifiedFiles; index += 1) {
    const dirIndex = Math.floor(index / filesPerDirectory)
    writeFileSync(
      path.join(
        repoPath,
        'src',
        `dir-${String(dirIndex).padStart(4, '0')}`,
        `file-${String(index).padStart(6, '0')}.ts`
      ),
      `export const tracked${index} = ${index}\nexport const modified${index} = true\n`
    )
  }

  return { repoPath, trackedFiles, untrackedFiles, modifiedFiles }
}

import { stat, symlink } from 'node:fs/promises'
import * as path from 'node:path'
import {
  runWithinGitWorktreeDeadline,
  type GitWorktreeCreateDeadline
} from './git-worktree-create-timeout'

export type GitCryptWorktreeExec = (
  args: string[],
  cwd: string
) => Promise<{ stdout: string; stderr?: string }>

export type ResolveGitOutputPath = (cwd: string, outputPath: string) => string

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function isMissingPathError(error: unknown): boolean {
  const code = getErrorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function isDirectory(
  pathValue: string,
  deadline?: GitWorktreeCreateDeadline
): Promise<boolean> {
  try {
    const result = deadline
      ? await runWithinGitWorktreeDeadline(deadline, `filesystem stat of "${pathValue}"`, () =>
          stat(pathValue)
        )
      : await stat(pathValue)
    return result.isDirectory()
  } catch (error) {
    if (isMissingPathError(error)) {
      return false
    }
    throw error
  }
}

function resolvePathFromGit(cwd: string, outputPath: string): string {
  return path.resolve(cwd, outputPath.trim())
}

export async function findGitCryptStateDirectory(
  git: GitCryptWorktreeExec,
  repoPath: string,
  resolveGitPath: ResolveGitOutputPath = resolvePathFromGit,
  deadline?: GitWorktreeCreateDeadline,
  commonGitDir?: string
): Promise<string | null> {
  if (commonGitDir) {
    const candidate = path.join(commonGitDir, 'git-crypt')
    return (await isDirectory(candidate, deadline)) ? candidate : null
  }
  const dotGitPath = path.join(repoPath, '.git')
  try {
    const dotGit = deadline
      ? await runWithinGitWorktreeDeadline(deadline, `filesystem stat of "${dotGitPath}"`, () =>
          stat(dotGitPath)
        )
      : await stat(dotGitPath)
    if (dotGit.isDirectory()) {
      const candidate = path.join(dotGitPath, 'git-crypt')
      return (await isDirectory(candidate, deadline)) ? candidate : null
    }
    if (dotGit.isFile()) {
      // Why: linked worktrees and separate-git-dir checkouts use a .git file;
      // ask Git for the common dir instead of guessing its target layout.
      const { stdout } = await git(['rev-parse', '--git-common-dir'], repoPath)
      const candidate = path.join(resolveGitPath(repoPath, stdout), 'git-crypt')
      return (await isDirectory(candidate, deadline)) ? candidate : null
    }
    return null
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error
    }
  }

  // Why: a bare repository is its own Git dir and has no nested .git entry.
  const bareCandidate = path.join(repoPath, 'git-crypt')
  return (await isDirectory(bareCandidate, deadline)) ? bareCandidate : null
}

export async function shareGitCryptStateWithWorktree(
  git: GitCryptWorktreeExec,
  gitCryptDir: string,
  worktreePath: string,
  resolveGitPath: ResolveGitOutputPath = resolvePathFromGit,
  deadline?: GitWorktreeCreateDeadline
): Promise<void> {
  const { stdout } = await git(['rev-parse', '--absolute-git-dir'], worktreePath)
  const destination = path.join(resolveGitPath(worktreePath, stdout), 'git-crypt')
  // Why: one repository-wide authority preserves lock/unlock semantics and never duplicates raw keys.
  const link = () =>
    symlink(gitCryptDir, destination, process.platform === 'win32' ? 'junction' : 'dir')
  await (deadline
    ? runWithinGitWorktreeDeadline(deadline, `git-crypt state link at "${destination}"`, link)
    : link())
}

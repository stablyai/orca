import { cp, stat, symlink } from 'node:fs/promises'
import * as path from 'node:path'

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

async function isDirectory(pathValue: string): Promise<boolean> {
  try {
    return (await stat(pathValue)).isDirectory()
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
  resolveGitPath: ResolveGitOutputPath = resolvePathFromGit
): Promise<string | null> {
  const dotGitPath = path.join(repoPath, '.git')
  try {
    const dotGit = await stat(dotGitPath)
    if (dotGit.isDirectory()) {
      const candidate = path.join(dotGitPath, 'git-crypt')
      return (await isDirectory(candidate)) ? candidate : null
    }
    if (dotGit.isFile()) {
      // Why: linked worktrees and separate-git-dir checkouts use a .git file;
      // ask Git for the common dir instead of guessing its target layout.
      const { stdout } = await git(['rev-parse', '--git-common-dir'], repoPath)
      const candidate = path.join(resolveGitPath(repoPath, stdout), 'git-crypt')
      return (await isDirectory(candidate)) ? candidate : null
    }
    return null
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error
    }
  }

  // Why: a bare repository is its own Git dir and has no nested .git entry.
  const bareCandidate = path.join(repoPath, 'git-crypt')
  return (await isDirectory(bareCandidate)) ? bareCandidate : null
}

function canFallBackFromDirectoryLink(error: unknown): boolean {
  const code = getErrorCode(error)
  return code === 'EPERM' || code === 'EACCES' || code === 'EINVAL' || code === 'ENOSYS'
}

export async function shareGitCryptStateWithWorktree(
  git: GitCryptWorktreeExec,
  gitCryptDir: string,
  worktreePath: string,
  resolveGitPath: ResolveGitOutputPath = resolvePathFromGit
): Promise<void> {
  const { stdout } = await git(['rev-parse', '--absolute-git-dir'], worktreePath)
  const destination = path.join(resolveGitPath(worktreePath, stdout), 'git-crypt')
  try {
    // Why: git-crypt treats its state as repository-wide; sharing it preserves
    // lock/unlock semantics across linked worktrees instead of duplicating keys.
    await symlink(gitCryptDir, destination, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (!canFallBackFromDirectoryLink(error)) {
      throw error
    }
    // Why: some Windows/WSL filesystems disallow directory links; copying is
    // the compatibility fallback that still makes the initial checkout usable.
    await cp(gitCryptDir, destination, { recursive: true, force: false, errorOnExist: true })
  }
}

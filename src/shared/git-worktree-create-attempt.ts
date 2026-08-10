import * as path from 'node:path'
import type { ResolveGitOutputPath } from './git-crypt-worktree-state'

export type GitWorktreeCreateAttempt = Readonly<{
  gitDir: string
  branchRef: string
}>

type GitWorktreeCreateAttemptExec = (
  args: string[],
  cwd: string
) => Promise<{ stdout: string; stderr?: string }>

function looksLikeWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function normalizePath(value: string): string {
  const api = process.platform === 'win32' || looksLikeWindowsPath(value) ? path.win32 : path.posix
  const normalized = api.normalize(api.resolve(value))
  return api === path.win32 ? normalized.toLowerCase() : normalized
}

export async function captureGitWorktreeCreateAttempt(
  git: GitWorktreeCreateAttemptExec,
  targetDir: string,
  branchName: string,
  resolveGitPath: ResolveGitOutputPath = (cwd, output) => path.resolve(cwd, output.trim())
): Promise<GitWorktreeCreateAttempt> {
  const { stdout } = await git(['rev-parse', '--absolute-git-dir'], targetDir)
  const gitDirOutput = stdout.trim()
  if (!gitDirOutput) {
    throw new Error(`Git did not return attempt identity for worktree "${targetDir}".`)
  }
  return {
    gitDir: normalizePath(resolveGitPath(targetDir, gitDirOutput)),
    branchRef: `refs/heads/${branchName.replace(/^refs\/heads\//, '')}`
  }
}

export async function gitWorktreeCreateAttemptMatches(
  git: GitWorktreeCreateAttemptExec,
  targetDir: string,
  attempt: GitWorktreeCreateAttempt,
  resolveGitPath?: ResolveGitOutputPath
): Promise<boolean> {
  try {
    const current = await captureGitWorktreeCreateAttempt(
      git,
      targetDir,
      attempt.branchRef,
      resolveGitPath
    )
    return current.gitDir === attempt.gitDir && current.branchRef === attempt.branchRef
  } catch {
    return false
  }
}

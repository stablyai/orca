import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import type { ResolveGitOutputPath } from './git-crypt-worktree-state'

export type GitWorktreeCreateAttempt = Readonly<{
  gitDir: string
  branchRef: string
  branchOid: string
  incarnationMarker: string
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

function createIncarnationMarker(): string {
  const encodedToken = randomUUID()
    .replaceAll('-', '')
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(65 + Number.parseInt(digit, 16)))
  return `ORCA_WORKTREE_INCARNATION_${encodedToken}`
}

export async function captureGitWorktreeCreateAttempt(
  git: GitWorktreeCreateAttemptExec,
  targetDir: string,
  branchName: string,
  branchOid: string,
  resolveGitPath: ResolveGitOutputPath = (cwd, output) => path.resolve(cwd, output.trim())
): Promise<GitWorktreeCreateAttempt> {
  const { stdout } = await git(['rev-parse', '--absolute-git-dir'], targetDir)
  const gitDirOutput = stdout.trim()
  if (!gitDirOutput) {
    throw new Error(`Git did not return attempt identity for worktree "${targetDir}".`)
  }
  const branchRef = `refs/heads/${branchName.replace(/^refs\/heads\//, '')}`
  const incarnationMarker = createIncarnationMarker()
  await git(['symbolic-ref', incarnationMarker, branchRef], targetDir)
  return {
    gitDir: normalizePath(resolveGitPath(targetDir, gitDirOutput)),
    branchRef,
    branchOid,
    incarnationMarker
  }
}

export async function gitWorktreeCreateAttemptMatches(
  git: GitWorktreeCreateAttemptExec,
  targetDir: string,
  attempt: GitWorktreeCreateAttempt
): Promise<boolean> {
  try {
    await git(['symbolic-ref', '--quiet', attempt.incarnationMarker], targetDir)
    const { stdout } = await git(['rev-parse', '--verify', attempt.branchRef], targetDir)
    return stdout.trim() === attempt.branchOid
  } catch {
    return false
  }
}

// Transport-agnostic Spotlight sync engine. All git access goes through the
// injected executor so the same logic can run locally, under WSL translation,
// or relay-side on an SSH host (phase 2). Commands are argv-only — no shell.
import type { GitConflictOperation } from './git-status-types'
import type { SpotlightErrorCode } from './spotlight'

export type SpotlightGitExecutor = (
  args: string[],
  cwd: string,
  opts?: { env?: Record<string, string> }
) => Promise<{ stdout: string; stderr?: string }>

export type SpotlightGitContext = {
  git: SpotlightGitExecutor
  detectConflict: (path: string) => Promise<GitConflictOperation>
}

export class SpotlightCoreError extends Error {
  readonly code: SpotlightErrorCode

  constructor(code: SpotlightErrorCode, message: string) {
    super(message)
    this.name = 'SpotlightCoreError'
    this.code = code
  }
}

export const IDENTITY_ARGS = [
  '-c',
  'user.name=Orca Spotlight',
  '-c',
  'user.email=spotlight@orca.local'
] as const

function stderrOf(error: unknown): string {
  if (error && typeof error === 'object') {
    const maybe = error as { stderr?: unknown; message?: unknown }
    if (typeof maybe.stderr === 'string' && maybe.stderr.trim()) {
      return maybe.stderr.trim()
    }
    if (typeof maybe.message === 'string') {
      return maybe.message
    }
  }
  return String(error)
}

export async function git(
  ctx: SpotlightGitContext,
  cwd: string,
  args: string[],
  opts?: { env?: Record<string, string> }
): Promise<string> {
  try {
    const { stdout } = await ctx.git(args, cwd, opts)
    return stdout.trim()
  } catch (error) {
    throw new SpotlightCoreError('git-failed', `git ${args[0]} failed: ${stderrOf(error)}`)
  }
}

/** Like `git`, but a non-zero exit means "absent" rather than failure. */
export async function gitTry(
  ctx: SpotlightGitContext,
  cwd: string,
  args: string[]
): Promise<string | null> {
  try {
    const { stdout } = await ctx.git(args, cwd)
    const value = stdout.trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

export async function resolveHead(ctx: SpotlightGitContext, path: string): Promise<string> {
  const head = await gitTry(ctx, path, ['rev-parse', '--verify', '-q', 'HEAD'])
  if (!head) {
    throw new SpotlightCoreError('unborn-head', `${path} has no commits yet.`)
  }
  return head
}

export function stripHeadsPrefix(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}

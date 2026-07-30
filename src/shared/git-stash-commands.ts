import type {
  GitStashEntry,
  GitStashMutationResult,
  GitStashPushOptions,
  GitStashPushResult
} from './git-stash-types'
import { GIT_STASH_LIST_ARGS, parseGitStashList } from './git-stash-list-output'
import { isStashApplyConflictOutput } from './git-stash-conflict'

/**
 * The stash command set, with the git runner injected so main and the relay share
 * one implementation. Structurally compatible with the relay's `GitExec`.
 *
 * Cache invalidation is deliberately NOT handled here — each host wraps these
 * with its own (`runWithGitReadCacheInvalidation` in main,
 * `runWithGitReadCacheClear` in the relay).
 */
export type GitStashExec = (
  args: string[],
  cwd: string
) => Promise<{ stdout: string; stderr: string }>

/** Longest a stash message may be before we refuse it, matching the RPC schema. */
export const MAX_STASH_MESSAGE_LENGTH = 500

/**
 * Reject anything that isn't git's own `stash@{N}`. Defense-in-depth: callers
 * also validate at the RPC schema, but the relay entrypoint is reachable
 * independently. Blocks flag injection and stops `--all`/`-p`/an arbitrary rev
 * from reaching a destructive subcommand.
 */
export function assertValidStashRef(ref: unknown): asserts ref is string {
  if (typeof ref !== 'string' || !/^stash@\{\d+\}$/.test(ref)) {
    throw new Error('invalid_stash_ref')
  }
}

function assertValidStashMessage(message: unknown): asserts message is string {
  // Why bound it: an empty `-m` produces a confusingly blank stash subject, and
  // an unbounded one bloats the reflog. A `-`-prefixed message needs no guard —
  // `-m` consumes the next argv token as its value, and args are passed as an
  // array, so it is never re-parsed as an option.
  if (
    typeof message !== 'string' ||
    message.length === 0 ||
    message.length > MAX_STASH_MESSAGE_LENGTH
  ) {
    throw new Error('invalid_stash_message')
  }
}

function assertValidWorktreePath(worktreePath: unknown): asserts worktreePath is string {
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) {
    throw new Error('invalid_worktree_path')
  }
}

/** List stash entries, newest first (git's own `refs/stash` reflog order). */
export async function listStashesWith(
  exec: GitStashExec,
  worktreePath: string
): Promise<GitStashEntry[]> {
  assertValidWorktreePath(worktreePath)
  const { stdout } = await exec([...GIT_STASH_LIST_ARGS], worktreePath)
  return parseGitStashList(stdout)
}

/**
 * Stash working-tree changes. `includeUntracked` adds `-u`; without it git
 * stashes tracked modifications only.
 *
 * Returns `stashed: false` (not an error) when there was nothing to stash — git
 * exits 0 printing "No local changes to save", so the caller must not report a
 * success that didn't happen.
 */
export async function stashChangesWith(
  exec: GitStashExec,
  worktreePath: string,
  pushOptions: GitStashPushOptions = {}
): Promise<GitStashPushResult> {
  assertValidWorktreePath(worktreePath)
  const args = ['stash', 'push']
  if (pushOptions.includeUntracked) {
    args.push('--include-untracked')
  }
  if (pushOptions.message !== undefined) {
    assertValidStashMessage(pushOptions.message)
    args.push('-m', pushOptions.message)
  }
  // Why: no pathspecs follow, so `--` keeps a message that looks like a path from
  // being reinterpreted.
  args.push('--')

  try {
    const { stdout, stderr } = await exec(args, worktreePath)
    return { success: true, stashed: !isNothingToStashOutput(`${stdout}\n${stderr}`) }
  } catch (error) {
    return { success: false, stashed: false, error: readGitFailureText(error, 'Stash failed') }
  }
}

/** Apply a stash and keep it in the list. `ref` null targets the latest entry. */
export async function applyStashWith(
  exec: GitStashExec,
  worktreePath: string,
  ref: string | null,
  expectedCommitOid?: string
): Promise<GitStashMutationResult> {
  return restoreStash('apply', exec, worktreePath, ref, expectedCommitOid)
}

/**
 * Apply a stash and drop it on success.
 *
 * On conflict git keeps the entry and says so; we mirror that rather than
 * compensating — auto-dropping would destroy the user's only copy of a
 * half-applied changeset, and auto-reverting would discard resolution work.
 */
export async function popStashWith(
  exec: GitStashExec,
  worktreePath: string,
  ref: string | null,
  expectedCommitOid?: string
): Promise<GitStashMutationResult> {
  return restoreStash('pop', exec, worktreePath, ref, expectedCommitOid)
}

/** Delete one stash entry permanently. */
export async function dropStashWith(
  exec: GitStashExec,
  worktreePath: string,
  ref: string,
  expectedCommitOid?: string
): Promise<void> {
  assertValidWorktreePath(worktreePath)
  assertValidStashRef(ref)
  await assertStashEntryUnmoved(exec, worktreePath, ref, expectedCommitOid)
  await exec(['stash', 'drop', '--', ref], worktreePath)
}

/** Delete every stash entry permanently. */
export async function clearStashesWith(exec: GitStashExec, worktreePath: string): Promise<void> {
  assertValidWorktreePath(worktreePath)
  await exec(['stash', 'clear'], worktreePath)
}

async function restoreStash(
  subcommand: 'apply' | 'pop',
  exec: GitStashExec,
  worktreePath: string,
  ref: string | null,
  expectedCommitOid: string | undefined
): Promise<GitStashMutationResult> {
  assertValidWorktreePath(worktreePath)
  if (ref !== null) {
    assertValidStashRef(ref)
  }
  // Why: verify whenever the caller supplied an oid, including for the implicit
  // newest entry — "pop the latest, but only if it is still the one I saw" is a
  // legitimate request, and skipping the check there would leave exactly the
  // concurrent-stash race this guard exists to close.
  await assertStashEntryUnmoved(exec, worktreePath, ref ?? 'stash@{0}', expectedCommitOid)
  try {
    await exec(
      ref === null ? ['stash', subcommand] : ['stash', subcommand, '--', ref],
      worktreePath
    )
    return { success: true }
  } catch (error) {
    const text = readGitOutputFields(error).join('\n')
    if (isStashApplyConflictOutput(text)) {
      // Why: conflicts are an expected outcome — the entry survives and the
      // working tree holds the merge, so the UI explains rather than retries.
      return {
        success: false,
        conflicted: true,
        error: readGitFailureText(error, `Stash ${subcommand} hit conflicts`)
      }
    }
    return { success: false, error: readGitFailureText(error, `Stash ${subcommand} failed`) }
  }
}

/**
 * Fail before a destructive op when the entry the user picked is no longer at
 * that index.
 *
 * Why: `stash@{N}` is positional, and agents run git in the same worktree — an
 * out-of-band `git stash push` between the picker rendering and the click would
 * silently retarget pop/drop at someone else's work.
 */
async function assertStashEntryUnmoved(
  exec: GitStashExec,
  worktreePath: string,
  ref: string,
  expectedCommitOid: string | undefined
): Promise<void> {
  if (!expectedCommitOid) {
    return
  }
  let resolved: string
  try {
    const { stdout } = await exec(
      ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      worktreePath
    )
    resolved = stdout.trim()
  } catch {
    // Why: a reflog index past the end is a fatal (exit 128), not empty output —
    // the entry is gone, which is the same situation as a shift.
    throw new Error('stash_entry_moved')
  }
  if (resolved !== expectedCommitOid) {
    throw new Error('stash_entry_moved')
  }
}

// Why: git reports an empty working tree on stdout with a zero exit, so this is
// the only signal that `stash push` created nothing.
function isNothingToStashOutput(text: string): boolean {
  return /no local changes to save/i.test(text)
}

// Why: execFile rejections carry the useful text on stderr (hooks) or stdout, not
// only `.message`. Mirrors commitChanges in src/main/git/status.ts.
function readGitOutputFields(error: unknown): string[] {
  if (typeof error !== 'object' || error === null) {
    return []
  }
  return ['stderr', 'stdout']
    .map((key) => (error as Record<string, unknown>)[key])
    .map((value) =>
      typeof value === 'string' ? value : value instanceof Uint8Array ? bufferToText(value) : ''
    )
    .filter((value) => value.length > 0)
}

function bufferToText(value: Uint8Array): string {
  return new TextDecoder().decode(value)
}

function readGitFailureText(error: unknown, fallback: string): string {
  for (const field of readGitOutputFields(error)) {
    const trimmed = field.trim()
    if (trimmed.length > 0) {
      return trimmed
    }
  }
  return error instanceof Error && error.message.length > 0 ? error.message : fallback
}

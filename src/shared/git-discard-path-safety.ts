import { lstat, realpath } from 'fs/promises'
import * as path from 'path'

function isENOENT(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function isInsideOrEqual(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath)
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  )
}

async function assertRealPathInsideWorktree(
  realWorktreePath: string,
  candidatePath: string,
  originalFilePath: string
): Promise<void> {
  const realCandidatePath = path.resolve(await realpath(candidatePath))
  if (!isInsideOrEqual(realWorktreePath, realCandidatePath)) {
    throw new Error(`Path "${originalFilePath}" resolves outside the worktree`)
  }
}

async function assertNearestExistingParentInsideWorktree(
  realWorktreePath: string,
  candidatePath: string,
  originalFilePath: string
): Promise<void> {
  let parentPath = path.dirname(candidatePath)
  while (parentPath !== path.dirname(parentPath)) {
    try {
      await assertRealPathInsideWorktree(realWorktreePath, parentPath, originalFilePath)
      return
    } catch (error) {
      if (!isENOENT(error)) {
        throw error
      }
      parentPath = path.dirname(parentPath)
    }
  }

  throw new Error(`Path "${originalFilePath}" resolves outside the worktree`)
}

function assertTargetIsWorktreeChild(
  resolvedWorktreePath: string,
  resolvedTarget: string,
  originalFilePath: string
): void {
  const relativeTarget = path.relative(resolvedWorktreePath, resolvedTarget)
  // Why: force-removing the worktree root is never a valid untracked discard,
  // even when callers accidentally pass an empty or self-referential path.
  if (
    relativeTarget === '' ||
    relativeTarget === '.' ||
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarget)
  ) {
    throw new Error(`Path "${originalFilePath}" resolves outside the worktree`)
  }
}

async function validateUntrackedDiscardTarget(
  worktreePath: string,
  filePath: string
): Promise<string> {
  const resolvedWorktreePath = path.resolve(worktreePath)
  const resolvedTarget = path.resolve(worktreePath, filePath)
  assertTargetIsWorktreeChild(resolvedWorktreePath, resolvedTarget, filePath)

  const realWorktreePath = path.resolve(await realpath(worktreePath))

  try {
    const targetStats = await lstat(resolvedTarget)
    // Why: discard should remove a symlink leaf itself, but symlinked parents
    // must not redirect recursive removal outside the real worktree.
    const pathToValidate = targetStats.isSymbolicLink()
      ? path.dirname(resolvedTarget)
      : resolvedTarget
    await assertRealPathInsideWorktree(realWorktreePath, pathToValidate, filePath)
  } catch (error) {
    if (!isENOENT(error)) {
      throw error
    }
    await assertNearestExistingParentInsideWorktree(realWorktreePath, resolvedTarget, filePath)
  }

  return resolvedTarget
}

export async function removeSafeUntrackedDiscardTarget(
  worktreePath: string,
  filePath: string,
  removePath: (filePath: string) => Promise<void>
): Promise<void> {
  await validateUntrackedDiscardTarget(worktreePath, filePath)
  await removePath(filePath)
}

export async function removeSafeUntrackedDiscardTargets(
  worktreePath: string,
  filePaths: readonly string[],
  removePaths: (filePaths: readonly string[]) => Promise<void>,
  beforeRemove?: () => Promise<void>
): Promise<void> {
  await Promise.all(
    filePaths.map((filePath) => validateUntrackedDiscardTarget(worktreePath, filePath))
  )

  // Why: bulk discard must validate every untracked path before mutating
  // tracked files, then recheck before the caller's Git-bounded cleanup runs.
  await beforeRemove?.()

  await Promise.all(
    filePaths.map((filePath) => validateUntrackedDiscardTarget(worktreePath, filePath))
  )
  await removePaths(filePaths)
}

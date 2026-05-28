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

export async function resolveSafeUntrackedDiscardTarget(
  worktreePath: string,
  filePath: string
): Promise<string> {
  const resolvedTarget = path.resolve(worktreePath, filePath)
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

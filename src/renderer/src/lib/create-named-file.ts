import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { createRuntimePath } from '../runtime/runtime-file-mutation-client'
import { runtimePathExists } from '../runtime/runtime-file-metadata-client'
import { runtimeTargetEnvironmentId } from '../runtime/runtime-client-target'
import { detectLanguage } from './language-detect'
import { getRelativePathInsideRoot, joinPath } from './path'

const MAX_UNTITLED_ATTEMPTS = 1000

export class NamedFileExistsError extends Error {
  constructor(readonly fileName: string) {
    super(`A file named '${fileName}' already exists`)
  }
}

export class NamedFileOutsideWorkspaceError extends Error {
  constructor() {
    super('Folder must be inside the current workspace')
  }
}

export type NamedFileOpenInfo = {
  filePath: string
  relativePath: string
  worktreeId: string
  runtimeEnvironmentId?: string
  language: string
  mode: 'edit'
}

export type NamedFileContext = {
  target: RuntimeClientTarget
  worktreeId: string
  worktreePath: string
  connectionId?: string
  expectedExecutionHostId?: 'local' | `ssh:${string}`
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
}

/** Smallest `Untitled<N>` (N from 1) that `isTaken` does not report as present. */
export async function nextUntitledName(
  isTaken: (name: string) => Promise<boolean>
): Promise<string> {
  for (let n = 1; n <= MAX_UNTITLED_ATTEMPTS; n += 1) {
    const candidate = `Untitled${n}`
    if (!(await isTaken(candidate))) {
      return candidate
    }
  }
  throw new Error(`Unable to find a free Untitled name after ${MAX_UNTITLED_ATTEMPTS} attempts.`)
}

/** Why: the filesystem layer refuses SSH-owned paths, so the dialog must not offer a create that cannot succeed. */
export function isSshOwnedFileContext(
  context: Pick<NamedFileContext, 'connectionId' | 'expectedExecutionHostId'>
): boolean {
  return (
    Boolean(context.connectionId) || Boolean(context.expectedExecutionHostId?.startsWith('ssh:'))
  )
}

/**
 * Workspace-relative folder ('' for the root), or null when `dir` is outside `root` or has `.`/`..` segments.
 * Lexical only: symlinks are left to the host's existing path authorization.
 */
export function getNamedFileRelativeDirectory(dir: string, root: string): string | null {
  const relative = getRelativePathInsideRoot(dir, root)
  if (relative === null) {
    return null
  }
  return relative.split('/').some((segment) => segment === '.' || segment === '..')
    ? null
    : relative
}

/** Why: an empty or separator-bearing name must never reach the filesystem as a nested path. */
export function hasPathSeparator(name: string): boolean {
  return /[/\\]/.test(name)
}

/** The name a blank Name field would get in `dir` right now. */
export async function suggestUntitledName(
  context: NamedFileContext,
  dir: string,
  assertOperationCurrent: () => void
): Promise<string> {
  if (getNamedFileRelativeDirectory(dir, context.worktreePath) === null) {
    throw new NamedFileOutsideWorkspaceError()
  }
  return nextUntitledName(async (candidate) => {
    assertOperationCurrent()
    return runtimePathExists(context, joinPath(dir, candidate))
  })
}

/** Creates `<dir>/<name>` (blank name → `Untitled<N>`) and returns openFile metadata; throws NamedFileExistsError on collision. */
export async function createNamedFile(
  context: NamedFileContext,
  dir: string,
  requestedName: string,
  assertOperationCurrent: () => void
): Promise<NamedFileOpenInfo> {
  // Why: validate before any filesystem probe or write so a bad folder or name never reaches the host.
  const relativeDir = getNamedFileRelativeDirectory(dir, context.worktreePath)
  if (relativeDir === null) {
    throw new NamedFileOutsideWorkspaceError()
  }
  const name = requestedName.trim()
  if (name === '.' || name === '..' || hasPathSeparator(name)) {
    throw new Error('Invalid file name')
  }
  let fileName = name
  if (fileName) {
    assertOperationCurrent()
    if (await runtimePathExists(context, joinPath(dir, fileName))) {
      throw new NamedFileExistsError(fileName)
    }
  } else {
    fileName = await suggestUntitledName(context, dir, assertOperationCurrent)
  }

  const filePath = joinPath(dir, fileName)
  assertOperationCurrent()
  try {
    // Why: createFile uses wx, so a race with another writer surfaces as EEXIST instead of overwriting.
    await createRuntimePath(context, filePath, 'file')
  } catch (error) {
    if (error instanceof Error && /EEXIST|exists/.test(error.message)) {
      throw new NamedFileExistsError(fileName)
    }
    throw error
  }
  // Why: the write is async; a stale owner must not receive open metadata for a file it did not create.
  assertOperationCurrent()

  const environmentId = runtimeTargetEnvironmentId(context.target)
  return {
    filePath,
    relativePath: relativeDir ? `${relativeDir}/${fileName}` : fileName,
    worktreeId: context.worktreeId,
    runtimeEnvironmentId: environmentId ?? undefined,
    language: detectLanguage(fileName),
    mode: 'edit'
  }
}

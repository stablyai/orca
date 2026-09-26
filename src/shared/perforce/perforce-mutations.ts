import { access, constants, lstat, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { PerforceEntry, PerforceOperationResult } from './perforce-types'
import { escapeP4FileArg, runP4 } from './p4-command'

export function toResult(result: {
  code: number | null
  stdout: string
  stderr: string
}): PerforceOperationResult {
  const output = [result.stdout, result.stderr]
    .filter((text) => text.trim())
    .join('\n')
    .trim()
  return result.code === 0
    ? { success: true, output }
    : { success: false, output, error: result.stderr.trim() || output || 'p4 command failed' }
}

export function fileArgs(filePaths: readonly string[]): string[] {
  return filePaths.map(escapeP4FileArg)
}

/** Opens files for add/edit/delete as their on-disk state dictates. */
export async function reconcileFiles(
  cwd: string,
  filePaths: readonly string[],
  changelist?: number
): Promise<PerforceOperationResult> {
  const cl = changelist ? ['-c', String(changelist)] : []
  return toResult(await runP4(['reconcile', ...cl, ...fileArgs(filePaths)], { cwd }))
}

/** Checks files out for edit (used before writing a read-only workspace file). */
export async function editFiles(
  cwd: string,
  filePaths: readonly string[]
): Promise<PerforceOperationResult> {
  return toResult(await runP4(['edit', ...fileArgs(filePaths)], { cwd }))
}

/** Closes files without touching their content on disk. */
export async function closeFilesKeepingContent(
  cwd: string,
  filePaths: readonly string[]
): Promise<PerforceOperationResult> {
  return toResult(await runP4(['revert', '-k', ...fileArgs(filePaths)], { cwd }))
}

/** Discards local changes: reverts opened files, resyncs modified ones, deletes new ones. */
export async function discardFiles(
  cwd: string,
  entries: readonly Pick<PerforceEntry, 'path' | 'group' | 'action'>[]
): Promise<PerforceOperationResult> {
  const outputs: string[] = []
  const opened = entries.filter((entry) => entry.group === 'opened')
  const modified = entries.filter((entry) => entry.group === 'modified')
  const fresh = entries.filter((entry) => entry.group === 'new')
  if (opened.length > 0) {
    const result = toResult(
      await runP4(['revert', ...fileArgs(opened.map((e) => e.path))], { cwd })
    )
    if (!result.success) {
      return result
    }
    outputs.push(result.output)
    // Why: reverting an add leaves the file behind; a discard should remove it.
    for (const entry of opened.filter((e) => e.action === 'add' || e.action === 'branch')) {
      await rm(resolve(cwd, entry.path), { force: true })
    }
  }
  if (modified.length > 0) {
    const targets = fileArgs(modified.map((e) => `${e.path}`)).map((arg) => `${arg}#have`)
    const result = toResult(await runP4(['sync', '-f', ...targets], { cwd }))
    if (!result.success) {
      return result
    }
    outputs.push(result.output)
  }
  for (const entry of fresh) {
    await rm(resolve(cwd, entry.path), { force: true })
  }
  return { success: true, output: outputs.filter(Boolean).join('\n') }
}

export async function submitDefaultChangelist(
  cwd: string,
  description: string
): Promise<PerforceOperationResult> {
  return toResult(await runP4(['submit', '-d', description], { cwd, timeoutMs: 600_000 }))
}

export async function submitChangelist(
  cwd: string,
  changelist: number
): Promise<PerforceOperationResult> {
  return toResult(await runP4(['submit', '-c', String(changelist)], { cwd, timeoutMs: 600_000 }))
}

export async function syncLatest(cwd: string): Promise<PerforceOperationResult> {
  return toResult(await runP4(['sync'], { cwd, timeoutMs: 1_800_000 }))
}

/** True for an existing regular file the user cannot write, i.e. a synced file not yet opened for edit. */
export async function isReadOnlyWorkspaceFile(cwd: string, filePath: string): Promise<boolean> {
  const absolute = resolve(cwd, filePath)
  try {
    if (!(await lstat(absolute)).isFile()) {
      return false
    }
    await access(absolute, constants.W_OK)
    return false
  } catch (error) {
    return isErrnoCode(error, 'EACCES') || isErrnoCode(error, 'EPERM')
  }
}

/** Checks a read-only workspace file out for edit; writable, missing, and non-file paths are left alone. */
export async function checkoutIfReadOnly(cwd: string, filePath: string): Promise<void> {
  const absolute = resolve(cwd, filePath)
  try {
    if (!(await lstat(absolute)).isFile()) {
      return
    }
    await access(absolute, constants.W_OK)
  } catch (error) {
    if (isErrnoCode(error, 'EACCES') || isErrnoCode(error, 'EPERM')) {
      await editFiles(cwd, [filePath])
    }
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

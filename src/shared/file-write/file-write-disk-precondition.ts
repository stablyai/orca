import { getDiskBaselineSignature, getWrittenContentDiskSignature } from './disk-baseline-signature'
import { ERRNO_CODE_PATTERN } from '../errors/errno-code'

// Why: the host serves `files.writeIfUnchanged`; without it a client compares from its side first.
export const FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY =
  'files.write.disk-precondition.v1' as const

// Why separate: v1 hosts can rewrite identical text and cannot enforce lossless automatic saves.
export const FILE_WRITE_IDENTICAL_RUNTIME_CAPABILITY = 'files.write.identical-noop.v1' as const

export const FILE_WRITE_IF_UNCHANGED_METHOD = 'files.writeIfUnchanged'

// Why its own method: a host too old to serve it answers method_not_found, so a placeholder is kept
// rather than removed by a delete that cannot check what the path holds now.
export const FILE_DELETE_IF_UNCHANGED_METHOD = 'files.deleteIfUnchanged'

// Why a capability as well as the method: without it the host's `files.stat` and `files.delete` are
// separate requests, the read-then-delete window this guards against.
export const FILE_DELETE_IF_UNCHANGED_RUNTIME_CAPABILITY = 'files.delete.if-unchanged.v1' as const

/** Only a host that can hold the file open while it checks and deletes it may answer the guarded delete. */
export const FILE_DELETE_LOCAL_ONLY_MESSAGE = 'files.deleteIfUnchanged is local to this host'

/** v1 hosts cannot check bytes or skip identical writes; require a client-side read only for saves that must refuse non-UTF-8 files. */
export function hostEnforcesPrecondition(
  capabilities: readonly unknown[],
  precondition: FileWriteDiskPrecondition
): boolean {
  return (
    capabilities.includes(FILE_WRITE_IDENTICAL_RUNTIME_CAPABILITY) ||
    (capabilities.includes(FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY) &&
      precondition.requireLosslessUtf8 !== true)
  )
}

/** Refuse the write unless disk still holds the content this signature was taken over. */
export type FileWriteDiskPrecondition = {
  expectedSignature: string
  /** A missing file is written (recreated) instead of refused. */
  allowMissing?: boolean
  /** Refuse a file that isn't valid UTF-8 rather than convert it unasked. */
  requireLosslessUtf8?: boolean
}

/** `not-utf8`: a save met bytes it can't round-trip; older clients read it as `changed`. */
export type FileWriteDiskConflict = 'changed' | 'missing' | 'not-utf8'

export type FileWriteDiskComparison = FileWriteDiskConflict | 'identical' | null

export type FileWriteResult =
  | { ok: true; unchanged?: boolean }
  | { ok: false; diskConflict: FileWriteDiskConflict }

export const FILE_WRITE_OK: FileWriteResult = { ok: true }
export const FILE_WRITE_UNCHANGED: FileWriteResult = { ok: true, unchanged: true }

/** The guarded delete's answer: `deleted` on success, or the disk state that made it refuse. */
export type FileDeleteIfUnchangedResult =
  | { ok: true }
  | { ok: false; diskConflict: FileWriteDiskConflict }

export const FILE_DELETE_OK: FileDeleteIfUnchangedResult = { ok: true }

export function parseFileDeleteIfUnchangedResult(value: unknown): FileDeleteIfUnchangedResult {
  if (typeof value !== 'object' || value === null || !('ok' in value) || value.ok !== false) {
    return FILE_DELETE_OK
  }
  const diskConflict = 'diskConflict' in value ? value.diskConflict : undefined
  return {
    ok: false,
    diskConflict: diskConflict === 'missing' || diskConflict === 'not-utf8' ? diskConflict : 'changed'
  }
}

/** `current` is the decoded disk text, `null` when missing, `undefined` when not comparable text; `content` is the text being saved. */
export function compareDiskWritePrecondition(
  precondition: FileWriteDiskPrecondition,
  current: string | null | undefined,
  content: string
): FileWriteDiskComparison {
  if (current === null) {
    return precondition.allowMissing === true ? null : 'missing'
  }
  if (current === undefined) {
    return 'changed'
  }
  // Why: U+FFFD may stand for bytes a decode dropped, so decoded equality proves nothing.
  if (current === content && !current.includes('\uFFFD')) {
    return 'identical'
  }
  if (getDiskBaselineSignature(current) !== precondition.expectedSignature) {
    return 'changed'
  }
  // Why: decoded text can't tell a real U+FFFD from replaced bytes, so a reader of text stays conservative.
  return precondition.requireLosslessUtf8 && current.includes('\uFFFD') ? 'not-utf8' : null
}

/** Why: old hosts answer `{ ok: true }` or nothing; only an explicit `ok: false` is a refusal. */
export function parseFileWriteResult(value: unknown): FileWriteResult {
  if (typeof value !== 'object' || value === null || !('ok' in value)) {
    return FILE_WRITE_OK
  }
  if (value.ok !== false) {
    return value.ok === true && 'unchanged' in value && value.unchanged === true
      ? FILE_WRITE_UNCHANGED
      : FILE_WRITE_OK
  }
  const diskConflict = 'diskConflict' in value ? value.diskConflict : undefined
  return {
    ok: false,
    diskConflict:
      diskConflict === 'missing' || diskConflict === 'not-utf8' ? diskConflict : 'changed'
  }
}

/** Only a not-found answer proves the file is gone; a lost transport proves nothing. */
export function isConfirmedFileNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  // Other codes (an RPC envelope's 'runtime_error') carry no errno, so the wording decides.
  const code = 'code' in error ? error.code : undefined
  if (typeof code === 'string' && ERRNO_CODE_PATTERN.test(code)) {
    return code === 'ENOENT'
  }
  // Why only a leading wrapper is stripped: the rest may quote a path, which can spell anything.
  return NOT_FOUND_MESSAGE.test(error.message.replace(IPC_ERROR_WRAPPER, ''))
}

const IPC_ERROR_WRAPPER = /^Error invoking remote method '[^']*': (?:Error: )?/
const NOT_FOUND_MESSAGE = /^(?:ENOENT: no such file or directory|No such file(?: or directory)?$)/i

const FILE_TOO_LARGE_CODE = 'file_too_large'

/** A host's `file_too_large` refusal, which travels as the bare code in the message. */
export function isFileTooLargeCodeMessage(message: string): boolean {
  return message === FILE_TOO_LARGE_CODE
}

// Why both: hosts answer with the `file_too_large` code (carried as the message); local readers in prose.
export function isFileTooLargeMessage(message: string): boolean {
  return isFileTooLargeCodeMessage(message) || /\btoo large\b|\bis larger than\b/i.test(message)
}

function isFileTooLargeToReadError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const code = 'code' in error ? error.code : undefined
  return code === FILE_TOO_LARGE_CODE || isFileTooLargeMessage(error.message)
}

/** Settles a precondition whose disk read failed; rethrows anything that doesn't prove the disk state. */
export function diskConflictFromReadFailure(
  precondition: FileWriteDiskPrecondition,
  error: unknown
): FileWriteDiskConflict | null {
  if (isConfirmedFileNotFoundError(error)) {
    return precondition.allowMissing === true ? null : 'missing'
  }
  // Why: the baseline was read whole, so content too big to read now cannot match it.
  if (isFileTooLargeToReadError(error)) {
    return 'changed'
  }
  throw error
}

/** For writers that create or restore a file: write only where none exists or it already holds `content`. */
export function missingOrIdenticalPrecondition(content: string): FileWriteDiskPrecondition {
  return { expectedSignature: getWrittenContentDiskSignature(content), allowMissing: true }
}

export const FILE_ALREADY_EXISTS_DIFFERENTLY_MESSAGE =
  'A different file already exists at this path, so it was left unchanged.'

/** A write the host refused before writing anything, so retrying it later is safe. */
export class FileWriteRefusedError extends Error {
  constructor() {
    super(FILE_ALREADY_EXISTS_DIFFERENTLY_MESSAGE)
    this.name = 'FileWriteRefusedError'
  }
}

/** Turns a refusal into the error a caller's existing failure path already reports. */
export function assertFileWriteApplied(result: FileWriteResult): void {
  if (!result.ok) {
    throw new FileWriteRefusedError()
  }
}

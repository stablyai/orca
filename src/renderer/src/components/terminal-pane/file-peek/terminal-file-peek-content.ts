import type { FileLinkTarget } from '../terminal-file-link-target'
import type { RuntimeFileReadArgs } from '@/runtime/runtime-file-client-types'
import { getRelativePathInsideWorktree } from '@/runtime/runtime-file-routing'
import { readRuntimeFileRange, statRuntimeReadTarget } from '@/runtime/runtime-file-range-client'
import { detectLanguage } from '../../../../../shared/editor-language/editor-language-detect'
import { readRuntimeDirectoryPage } from '@/runtime/runtime-directory-page-client'
import { sortDirEntries } from '../../../../../shared/file-name-sort'
import { filePreviewForPath } from '../../../../../shared/file-preview-kind'
import { BINARY_PROBE_BYTES } from '../../../../../shared/binary-buffer'
import type { TerminalFilePeekContent } from './terminal-file-peek-content-types'
import { TerminalFilePeekLineWindow } from './terminal-file-peek-line-window'

const TEXT_BUDGET_BYTES = 1024 * 1024
const TEXT_CHUNK_BYTES = 64 * 1024

export function canPeekTerminalFileTarget(target: FileLinkTarget): boolean {
  const context = target.fileContext
  return (
    context.sourceHostResolved &&
    (context.target.kind !== 'environment' ||
      (Boolean(context.worktreeId) &&
        getRelativePathInsideWorktree(context.worktreePath, target.absolutePath) !== null))
  )
}

export async function loadTerminalFilePeek(
  target: FileLinkTarget,
  signal: AbortSignal
): Promise<TerminalFilePeekContent | null> {
  signal.throwIfAborted()
  if (!canPeekTerminalFileTarget(target)) {
    return null
  }
  const context = target.fileContext
  const relativePath = getRelativePathInsideWorktree(context.worktreePath, target.absolutePath)
  const args: RuntimeFileReadArgs = {
    target: context.target,
    filePath: target.absolutePath,
    worktreeId: context.worktreeId ?? undefined,
    relativePath: relativePath ?? undefined,
    connectionId: context.connectionId,
    expectedExternalSshTargetId: context.expectedExternalSshTargetId
  }
  try {
    // Workspace roots are directories; the range-read stat guard cannot address their empty path.
    const snapshot =
      relativePath === '' ? { isDirectory: true, size: 0 } : await statRuntimeReadTarget(args)
    signal.throwIfAborted()
    if (snapshot.isDirectory) {
      const page = await readRuntimeDirectoryPage(context, target.absolutePath, { limit: 21 })
      signal.throwIfAborted()
      return {
        kind: 'directory',
        path: target.absolutePath,
        entries: sortDirEntries([...page.entries]).slice(0, 20),
        hasMore: page.hasMore || page.entries.length > 20
      }
    }
    const preview = filePreviewForPath(target.absolutePath)
    if (preview?.kind === 'image') {
      return snapshot.size <= 10 * 1024 * 1024
        ? { kind: 'image', path: target.absolutePath, sizeBytes: snapshot.size }
        : { kind: 'notice', path: target.absolutePath, reason: 'too-large' }
    }
    if (preview) {
      return {
        kind: 'notice',
        path: target.absolutePath,
        reason: 'unsupported'
      }
    }
    return await readTextPeek(target, args, snapshot.size, signal)
  } catch {
    signal.throwIfAborted()
    return { kind: 'notice', path: target.absolutePath, reason: 'unreadable' }
  }
}

async function readTextPeek(
  target: FileLinkTarget,
  args: RuntimeFileReadArgs,
  size: number,
  signal: AbortSignal
): Promise<TerminalFilePeekContent> {
  if (target.line === null && detectLanguage(target.absolutePath) === 'markdown') {
    const length = Math.min(size, 16 * 1024)
    const bytes = length === 0 ? new Uint8Array() : await readRuntimeFileRange(args, 0, length)
    signal.throwIfAborted()
    if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
      return { kind: 'notice', path: target.absolutePath, reason: 'binary' }
    }
    return {
      kind: 'markdown',
      path: target.absolutePath,
      source: new TextDecoder().decode(bytes, { stream: bytes.length < size })
    }
  }
  const window = new TerminalFilePeekLineWindow(target.line)
  const budget = Math.min(size, TEXT_BUDGET_BYTES)
  let offset = 0
  let eof = size === 0
  let prefix = ''
  while (offset < budget && !window.complete) {
    const length = Math.min(TEXT_CHUNK_BYTES, budget - offset)
    const bytes = await readRuntimeFileRange(args, offset, length)
    signal.throwIfAborted()
    if (offset === 0) {
      if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
        return { kind: 'notice', path: target.absolutePath, reason: 'binary' }
      }
      prefix = new TextDecoder().decode(bytes.subarray(0, 256), {
        stream: true
      })
    }
    offset += bytes.length
    window.push(bytes)
    eof = offset >= size || bytes.length < length
    if (eof) {
      break
    }
  }
  const result = window.finish(eof)
  return result.kind === 'notice'
    ? { ...result, path: target.absolutePath }
    : {
        ...result,
        path: target.absolutePath,
        language: detectLanguage(target.absolutePath, prefix)
      }
}

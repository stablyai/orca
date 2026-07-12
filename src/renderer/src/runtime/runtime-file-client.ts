/* eslint-disable max-lines -- Why: this client intentionally centralizes the
file preload API plus remote runtime fallbacks so call sites cannot drift on
local-vs-environment routing rules. */
import type {
  DirEntry,
  FsChangedPayload,
  GlobalSettings,
  MarkdownDocument,
  SearchOptions,
  SearchResult
} from '../../../shared/types'
import type {
  RuntimeFilePreviewResult,
  RuntimeFileReadChunkResult,
  RuntimeFileReadResult
} from '../../../shared/runtime-types'
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  RuntimeRpcCallError,
  unwrapRuntimeRpcResult
} from './runtime-rpc-client'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { basename, joinPath, normalizeRelativePath } from '@/lib/path'
import {
  isWindowsAbsolutePathLike,
  relativePathInsideRoot
} from '../../../shared/cross-platform-path'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import {
  createEmptyRuntimeFileSearchResult,
  getRuntimeFileSearchRejectedField
} from './runtime-file-search-bounds'

export type RuntimeReadableFileContent = {
  content: string
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
  fileIdentity?: string
}

export type RuntimeFileReadArgs = {
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  filePath: string
  relativePath?: string
  worktreeId?: string
  connectionId?: string
  includeLocalLogMetadata?: boolean
}

export type RuntimeFileOperationArgs = {
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  worktreeId: string | null | undefined
  worktreePath: string | null | undefined
  connectionId?: string
}

export type RuntimeFileDownloadResult =
  | { canceled: true }
  | { canceled: false; destinationPath: string }

type StagedRuntimeImportSource =
  | {
      sourcePath: string
      status: 'staged'
      name: string
      kind: 'file' | 'directory'
      entries: StagedRuntimeImportEntry[]
    }
  | {
      sourcePath: string
      status: 'skipped'
      reason: 'missing' | 'symlink' | 'permission-denied' | 'unsupported'
    }
  | { sourcePath: string; status: 'failed'; reason: string }

type StagedRuntimeImportEntry =
  | { relativePath: string; kind: 'directory' }
  | { relativePath: string; kind: 'file'; contentBase64: string }

type RuntimeImportResult =
  | {
      sourcePath: string
      status: 'imported'
      destPath: string
      kind: 'file' | 'directory'
      renamed: boolean
    }
  | {
      sourcePath: string
      status: 'skipped'
      reason: 'missing' | 'symlink' | 'permission-denied' | 'unsupported'
    }
  | {
      sourcePath: string
      status: 'failed'
      reason: string
    }

type RuntimeFileWatchEvent =
  | { type: 'ready'; subscriptionId: string }
  | { type: 'changed'; worktree: string; events: FsChangedPayload['events'] }
  | { type: 'end' }

const REMOTE_UPLOAD_BASE64_CHUNK_CHARS = 512 * 1024
const REMOTE_DOWNLOAD_CHUNK_BYTES = 384 * 1024
const REMOTE_DOWNLOAD_UPDATE_REQUIRED_MESSAGE =
  'Remote file download requires a newer Orca server. Update the headless server and try again.'

type RemoteFileDownloadArgs = NonNullable<ReturnType<typeof getRemoteFileArgs>>

type RuntimeFileWatchListener = {
  onPayload: (payload: FsChangedPayload) => void
  onError?: (error: Error) => void
}

type SharedRuntimeFileWatch = {
  target: { kind: 'environment'; environmentId: string }
  worktreeId: string
  listeners: Set<RuntimeFileWatchListener>
  start: Promise<void>
  unsubscribe: (() => void) | null
  remoteSubscriptionId: string | null
  keepStreamUntilReady: boolean
  closed: boolean
}

const sharedRuntimeFileWatches = new Map<string, SharedRuntimeFileWatch>()

function getSharedRuntimeFileWatchKey(
  environmentId: string,
  worktreeId: string,
  worktreePath: string
): string {
  return `${environmentId}\0${worktreeId}\0${worktreePath}`
}

export function getRuntimeFileReadScope(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  connectionId: string | undefined
): string | undefined {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment' ? `runtime:${target.environmentId}` : connectionId
}

export async function readRuntimeFileContent({
  settings,
  filePath,
  relativePath,
  worktreeId,
  connectionId,
  includeLocalLogMetadata
}: RuntimeFileReadArgs): Promise<RuntimeReadableFileContent> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind !== 'environment') {
    return window.api.fs.readFile({ filePath, connectionId, includeLocalLogMetadata })
  }
  if (!worktreeId) {
    return window.api.fs.readFile({ filePath, connectionId, includeLocalLogMetadata })
  }
  if (!canReadRelativeRuntimeFile(relativePath)) {
    throw new Error('Remote file is outside the owning runtime worktree')
  }

  const worktree = toRuntimeWorktreeSelector(worktreeId)
  let result: RuntimeFileReadResult
  try {
    result = await callRuntimeRpc<RuntimeFileReadResult>(
      target,
      'files.read',
      { worktree, relativePath },
      { timeoutMs: 15_000 }
    )
  } catch (err) {
    // Why: files.read rejects binary paths with the typed 'binary_file' error; fall
    // back to the base64 preview RPC so PDFs/images render like local/SSH paths.
    // Match the exact typed error so an unrelated failure can't spoof the fallback.
    if (err instanceof RuntimeRpcCallError && err.message === 'binary_file') {
      return callRuntimeRpc<RuntimeFilePreviewResult>(
        target,
        'files.readPreview',
        { worktree, relativePath },
        { timeoutMs: 15_000 }
      )
    }
    throw err
  }
  if (result.truncated) {
    // Why: the runtime file RPC is preview-sized today; treating a truncated
    // payload as editable content would make saves overwrite the rest of the file.
    throw new Error(`Remote file is too large to open in the editor (${result.byteLength} bytes)`)
  }
  return { content: result.content, isBinary: false }
}

export async function readRuntimeFilePreview(
  context: RuntimeFileOperationArgs,
  filePath: string
): Promise<RuntimeFilePreviewResult> {
  const remoteArgs = getRemoteFileArgs(context, filePath)
  if (!remoteArgs) {
    if (hasRemoteRuntimeOwner(context)) {
      throw new Error('Remote file is outside the owning runtime worktree')
    }
    return window.api.fs.readFile({ filePath, connectionId: context.connectionId })
  }
  return callRuntimeRpc<RuntimeFilePreviewResult>(
    remoteArgs.target,
    'files.readPreview',
    { worktree: remoteArgs.worktreeSelector, relativePath: remoteArgs.relativePath },
    { timeoutMs: 15_000 }
  )
}

export async function downloadRuntimeFile(
  context: RuntimeFileOperationArgs,
  filePath: string,
  suggestedName: string
): Promise<RuntimeFileDownloadResult> {
  const remoteArgs = getRemoteFileArgs(context, filePath)
  if (!remoteArgs) {
    if (hasRemoteRuntimeOwner(context)) {
      throw new Error('Remote file is outside the owning runtime worktree')
    }
    if (context.connectionId) {
      return window.api.fs.downloadFile({ filePath, connectionId: context.connectionId })
    }
    const result = await readRuntimeFilePreview(context, filePath)
    return window.api.fs.saveDownloadedFile({
      suggestedName,
      content: result.content,
      encoding: result.isBinary ? 'base64' : 'utf8'
    })
  }

  if (!(await remoteChunkedDownloadAvailable(remoteArgs))) {
    return downloadRemoteFileViaPreview(remoteArgs, suggestedName)
  }

  const download = await window.api.fs.startDownloadedFile({ suggestedName })
  if (download.canceled) {
    return download
  }

  let finished = false
  try {
    let offset = 0
    for (;;) {
      const chunk = await readRemoteDownloadChunk(remoteArgs, offset)
      if (chunk.bytesRead > 0) {
        await window.api.fs.appendDownloadedFileChunk({
          transferId: download.transferId,
          contentBase64: chunk.contentBase64
        })
      }
      offset += chunk.bytesRead
      if (chunk.eof) {
        break
      }
      if (chunk.bytesRead <= 0) {
        throw new Error('Remote download stalled before reaching EOF')
      }
    }
    const result = await window.api.fs.finishDownloadedFile({ transferId: download.transferId })
    finished = true
    return result
  } finally {
    if (!finished) {
      await window.api.fs.cancelDownloadedFile({ transferId: download.transferId }).catch(() => {})
    }
  }
}

async function remoteChunkedDownloadAvailable(
  remoteArgs: RemoteFileDownloadArgs
): Promise<boolean> {
  try {
    await callRuntimeRpc<RuntimeFileReadChunkResult>(
      remoteArgs.target,
      'files.readChunk',
      {
        worktree: remoteArgs.worktreeSelector,
        relativePath: remoteArgs.relativePath,
        offset: 0,
        length: 1
      },
      { timeoutMs: 60_000 }
    )
    return true
  } catch (error) {
    // Why: compatible older headless servers may lack chunked downloads while
    // still supporting preview-sized file reads that can complete the request.
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return false
    }
    throw error
  }
}

async function readRemoteDownloadChunk(
  remoteArgs: RemoteFileDownloadArgs,
  offset: number
): Promise<RuntimeFileReadChunkResult> {
  return callRuntimeRpc<RuntimeFileReadChunkResult>(
    remoteArgs.target,
    'files.readChunk',
    {
      worktree: remoteArgs.worktreeSelector,
      relativePath: remoteArgs.relativePath,
      offset,
      length: REMOTE_DOWNLOAD_CHUNK_BYTES
    },
    { timeoutMs: 60_000 }
  )
}

async function downloadRemoteFileViaPreview(
  remoteArgs: RemoteFileDownloadArgs,
  suggestedName: string
): Promise<RuntimeFileDownloadResult> {
  try {
    const result = await callRuntimeRpc<RuntimeFilePreviewResult>(
      remoteArgs.target,
      'files.readPreview',
      { worktree: remoteArgs.worktreeSelector, relativePath: remoteArgs.relativePath },
      { timeoutMs: 15_000 }
    )
    // Why: old servers use an empty, metadata-free binary result to signal an
    // unsupported binary; recognized zero-byte previews are still complete.
    if (result.isBinary && !result.content && !result.isImage && !result.mimeType) {
      throw new Error(REMOTE_DOWNLOAD_UPDATE_REQUIRED_MESSAGE)
    }
    return window.api.fs.saveDownloadedFile({
      suggestedName,
      content: result.content,
      encoding: result.isBinary ? 'base64' : 'utf8'
    })
  } catch (error) {
    if (isUnsupportedRemotePreviewDownload(error)) {
      throw new Error(REMOTE_DOWNLOAD_UPDATE_REQUIRED_MESSAGE)
    }
    throw error
  }
}

function isUnsupportedRemotePreviewDownload(error: unknown): boolean {
  if (!(error instanceof RuntimeRpcCallError)) {
    return false
  }
  return (
    error.code === 'method_not_found' ||
    (error.code === 'runtime_error' &&
      (error.message === 'file_too_large' || error.message === 'binary_file'))
  )
}

export async function readRuntimeDirectory(
  context: RuntimeFileOperationArgs,
  dirPath: string
): Promise<DirEntry[]> {
  const remoteArgs = getRemoteFileArgs(context, dirPath)
  if (!remoteArgs) {
    assertLocalFilesystemFallbackAllowed(context)
    return window.api.fs.readDir({ dirPath, connectionId: context.connectionId })
  }
  return callRuntimeRpc<DirEntry[]>(
    remoteArgs.target,
    'files.readDir',
    { worktree: remoteArgs.worktreeSelector, relativePath: remoteArgs.relativePath },
    { timeoutMs: 15_000 }
  )
}

export async function writeRuntimeFile(
  context: RuntimeFileOperationArgs,
  filePath: string,
  content: string
): Promise<void> {
  const remoteArgs = getRemoteFileArgs(context, filePath)
  if (!remoteArgs) {
    assertLocalFilesystemFallbackAllowed(context)
    await window.api.fs.writeFile({ filePath, content, connectionId: context.connectionId })
    return
  }
  await callRuntimeRpc(
    remoteArgs.target,
    'files.write',
    { worktree: remoteArgs.worktreeSelector, relativePath: remoteArgs.relativePath, content },
    { timeoutMs: 15_000 }
  )
}

export async function createRuntimePath(
  context: RuntimeFileOperationArgs,
  path: string,
  kind: 'file' | 'directory'
): Promise<void> {
  const remoteArgs = getRemoteFileArgs(context, path)
  if (!remoteArgs) {
    assertLocalFilesystemFallbackAllowed(context)
    await (kind === 'directory'
      ? window.api.fs.createDir({ dirPath: path, connectionId: context.connectionId })
      : window.api.fs.createFile({ filePath: path, connectionId: context.connectionId }))
    return
  }
  await callRuntimeRpc(
    remoteArgs.target,
    kind === 'directory' ? 'files.createDir' : 'files.createFile',
    { worktree: remoteArgs.worktreeSelector, relativePath: remoteArgs.relativePath },
    { timeoutMs: 15_000 }
  )
}

export async function renameRuntimePath(
  context: RuntimeFileOperationArgs,
  oldPath: string,
  newPath: string
): Promise<void> {
  const oldRemoteArgs = getRemoteFileArgs(context, oldPath)
  const newRelativePath = getRelativePathInsideWorktree(context.worktreePath, newPath)
  if (!oldRemoteArgs || newRelativePath === null) {
    assertLocalFilesystemFallbackAllowed(context)
    await window.api.fs.rename({ oldPath, newPath, connectionId: context.connectionId })
    return
  }
  await callRuntimeRpc(
    oldRemoteArgs.target,
    'files.rename',
    {
      worktree: oldRemoteArgs.worktreeSelector,
      oldRelativePath: oldRemoteArgs.relativePath,
      newRelativePath
    },
    { timeoutMs: 15_000 }
  )
}

export async function copyRuntimePath(
  context: RuntimeFileOperationArgs,
  sourcePath: string,
  destinationPath: string
): Promise<void> {
  const sourceArgs = getRemoteFileArgs(context, sourcePath)
  const destinationArgs = getRemoteFileArgs(context, destinationPath)
  if (!sourceArgs || !destinationArgs) {
    assertLocalFilesystemFallbackAllowed(context)
    await window.api.fs.copy({
      sourcePath,
      destinationPath,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    sourceArgs.target,
    'files.copy',
    {
      worktree: sourceArgs.worktreeSelector,
      sourceRelativePath: sourceArgs.relativePath,
      destinationRelativePath: destinationArgs.relativePath
    },
    { timeoutMs: 15_000 }
  )
}

export async function deleteRuntimePath(
  context: RuntimeFileOperationArgs,
  targetPath: string,
  recursive?: boolean
): Promise<void> {
  const remoteArgs = getRemoteFileArgs(context, targetPath)
  if (!remoteArgs) {
    assertLocalFilesystemFallbackAllowed(context)
    await window.api.fs.deletePath({
      targetPath,
      connectionId: context.connectionId,
      recursive
    })
    return
  }
  await callRuntimeRpc(
    remoteArgs.target,
    'files.delete',
    { worktree: remoteArgs.worktreeSelector, relativePath: remoteArgs.relativePath, recursive },
    { timeoutMs: 15_000 }
  )
}

export async function deleteRuntimeRelativePath(
  context: RuntimeFileOperationArgs,
  relativePath: string,
  recursive?: boolean
): Promise<boolean> {
  const target = getActiveRuntimeTarget(context.settings)
  if (
    target.kind !== 'environment' ||
    !context.worktreeId ||
    !canReadRelativeRuntimeFile(relativePath)
  ) {
    return false
  }
  await callRuntimeRpc(
    target,
    'files.delete',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      relativePath: normalizeRelativePath(relativePath),
      recursive
    },
    { timeoutMs: 15_000 }
  )
  return true
}

export async function importExternalPathsToRuntime(
  context: RuntimeFileOperationArgs,
  sourcePaths: string[],
  destinationDir: string,
  options?: { ensureDestinationDir?: boolean }
): Promise<{ results: RuntimeImportResult[] }> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind !== 'environment' || !context.worktreeId || !context.worktreePath) {
    return window.api.fs.importExternalPaths({
      sourcePaths,
      destDir: destinationDir,
      connectionId: context.connectionId,
      ensureDir: options?.ensureDestinationDir
    })
  }

  const destinationArgs = getRemoteFileArgs(context, destinationDir)
  if (!destinationArgs) {
    throw new Error('Destination is outside the active runtime worktree')
  }

  const staged = await window.api.fs.stageExternalPathsForRuntimeUpload({ sourcePaths })
  const results: RuntimeImportResult[] = []
  const reservedNames = new Set<string>()

  await ensureRuntimeDirectory(context, destinationDir)

  for (const source of staged.sources as StagedRuntimeImportSource[]) {
    if (source.status !== 'staged') {
      results.push(source)
      continue
    }
    let createdDirectoryImportRoot: string | null = null
    try {
      const finalName = await deconflictRuntimeImportName(
        context,
        destinationDir,
        source.name,
        reservedNames
      )
      const destPath = joinPath(destinationDir, finalName)
      const destRelativePath = joinRuntimeRelativePath(destinationArgs.relativePath, finalName)
      for (const entry of source.entries) {
        const entryRelativePath = joinRuntimeRelativePath(destRelativePath, entry.relativePath)
        if (entry.kind === 'directory') {
          await callRuntimeRpc(
            target,
            'files.createDirNoClobber',
            {
              worktree: toRuntimeWorktreeSelector(context.worktreeId),
              relativePath: entryRelativePath
            },
            { timeoutMs: 15_000 }
          )
          if (source.kind === 'directory' && entry.relativePath === '') {
            createdDirectoryImportRoot = entryRelativePath
          }
          continue
        }
        await uploadRuntimeFileWithoutClobber(
          target,
          context.worktreeId,
          entryRelativePath,
          entry.contentBase64
        )
      }
      reservedNames.add(finalName)
      results.push({
        sourcePath: source.sourcePath,
        status: 'imported',
        destPath,
        kind: source.kind,
        renamed: finalName !== source.name
      })
    } catch (error) {
      if (createdDirectoryImportRoot) {
        // Why: match local directory imports by removing the no-clobber root
        // Orca created when a nested runtime upload fails halfway through.
        await callRuntimeRpc(
          target,
          'files.delete',
          {
            worktree: toRuntimeWorktreeSelector(context.worktreeId),
            relativePath: createdDirectoryImportRoot,
            recursive: true
          },
          { timeoutMs: 15_000 }
        ).catch(() => {})
      }
      results.push({
        sourcePath: source.sourcePath,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return { results }
}

async function uploadRuntimeFileWithoutClobber(
  target: { kind: 'environment'; environmentId: string },
  worktreeId: string,
  relativePath: string,
  contentBase64: string
): Promise<void> {
  const tempRelativePath = makeRuntimeUploadTempPath(relativePath)
  try {
    await writeRuntimeBase64File(target, worktreeId, tempRelativePath, contentBase64)
    await callRuntimeRpc(
      target,
      'files.commitUpload',
      {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        tempRelativePath,
        finalRelativePath: relativePath
      },
      { timeoutMs: 30_000 }
    )
  } finally {
    await callRuntimeRpc(
      target,
      'files.delete',
      {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        relativePath: tempRelativePath,
        recursive: false
      },
      { timeoutMs: 15_000 }
    ).catch(() => {})
  }
}

async function writeRuntimeBase64File(
  target: { kind: 'environment'; environmentId: string },
  worktreeId: string,
  relativePath: string,
  contentBase64: string
): Promise<void> {
  if (contentBase64.length <= REMOTE_UPLOAD_BASE64_CHUNK_CHARS) {
    await callRuntimeRpc(
      target,
      'files.writeBase64',
      { worktree: toRuntimeWorktreeSelector(worktreeId), relativePath, contentBase64 },
      { timeoutMs: 30_000 }
    )
    return
  }

  for (let offset = 0; offset < contentBase64.length; offset += REMOTE_UPLOAD_BASE64_CHUNK_CHARS) {
    await callRuntimeRpc(
      target,
      'files.writeBase64Chunk',
      {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        relativePath,
        contentBase64: contentBase64.slice(offset, offset + REMOTE_UPLOAD_BASE64_CHUNK_CHARS),
        append: offset > 0
      },
      { timeoutMs: 30_000 }
    )
  }
}

function makeRuntimeUploadTempPath(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath)
  const slashIndex = normalized.lastIndexOf('/')
  const dir = slashIndex === -1 ? '' : normalized.slice(0, slashIndex + 1)
  const leaf = slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1)
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${dir}.${leaf}.orca-upload-${nonce}`
}

async function ensureRuntimeDirectory(
  context: RuntimeFileOperationArgs,
  destinationDir: string
): Promise<void> {
  const destinationArgs = getRemoteFileArgs(context, destinationDir)
  if (!destinationArgs) {
    return
  }
  const parts = normalizeRelativePath(destinationArgs.relativePath)
    .split('/')
    .filter((part) => part.length > 0)
  let current = ''
  for (const part of parts) {
    current = joinRuntimeRelativePath(current, part)
    const absolutePath = joinPath(context.worktreePath ?? '', current)
    if (await runtimePathExists(context, absolutePath)) {
      continue
    }
    await callRuntimeRpc(
      destinationArgs.target,
      'files.createDir',
      { worktree: destinationArgs.worktreeSelector, relativePath: current },
      { timeoutMs: 15_000 }
    )
  }
}

export async function searchRuntimeFiles(
  context: RuntimeFileOperationArgs,
  options: SearchOptions
): Promise<SearchResult> {
  if (getRuntimeFileSearchRejectedField(options)) {
    return createEmptyRuntimeFileSearchResult()
  }
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind !== 'environment' || !context.worktreeId) {
    return window.api.fs.search({
      ...options,
      connectionId: context.connectionId
    })
  }
  const { rootPath: _rootPath, ...runtimeOptions } = options
  return callRuntimeRpc<SearchResult>(
    target,
    'files.search',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), ...runtimeOptions },
    { timeoutMs: 15_000 }
  )
}

export async function listRuntimeFiles(
  context: RuntimeFileOperationArgs,
  args: { rootPath: string; excludePaths?: string[]; requestToken?: string }
): Promise<string[]> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind !== 'environment' || !context.worktreeId) {
    return window.api.fs.listFiles({
      rootPath: args.rootPath,
      connectionId: context.connectionId,
      excludePaths: args.excludePaths,
      requestToken: args.requestToken
    })
  }
  return callRuntimeRpc<string[]>(
    target,
    'files.listAll',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      excludePaths: args.excludePaths
    },
    { timeoutMs: 15_000 }
  )
}

/**
 * Best-effort abort of an in-flight listRuntimeFiles call (#7721). Switching
 * workspaces must stop the previous workspace's full-tree scan — over SSH an
 * abandoned scan keeps loading the relay and starves fs.readDir/fs.stat.
 */
export function cancelRuntimeFileList(
  context: RuntimeFileOperationArgs,
  requestToken: string
): void {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind !== 'environment' || !context.worktreeId) {
    void window.api.fs.cancelListFiles({ requestToken }).catch(() => {
      /* cancellation is advisory; the request path has its own timeouts */
    })
  }
  // Environment runtimes bound files.listAll with their own RPC timeout.
}

export async function listRuntimeMarkdownDocuments(
  context: RuntimeFileOperationArgs,
  rootPath: string
): Promise<MarkdownDocument[]> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind !== 'environment' || !context.worktreeId) {
    return window.api.fs.listMarkdownDocuments({
      rootPath,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<MarkdownDocument[]>(
    target,
    'files.listMarkdownDocuments',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId) },
    { timeoutMs: 15_000 }
  )
}

export async function statRuntimePath(
  context: RuntimeFileOperationArgs,
  absolutePath: string
): Promise<{ size: number; isDirectory: boolean; mtime: number }> {
  const remoteArgs = getRemoteFileArgs(context, absolutePath)
  if (!remoteArgs) {
    assertLocalFilesystemFallbackAllowed(context)
    return window.api.fs.stat({
      filePath: absolutePath,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<{ size: number; isDirectory: boolean; mtime: number }>(
    remoteArgs.target,
    'files.stat',
    { worktree: remoteArgs.worktreeSelector, relativePath: remoteArgs.relativePath },
    { timeoutMs: 15_000 }
  )
}

export async function subscribeRuntimeFileChanges(
  context: RuntimeFileOperationArgs,
  onPayload: (payload: FsChangedPayload) => void,
  onError?: (error: Error) => void
): Promise<() => void> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind !== 'environment' || !context.worktreeId || !context.worktreePath) {
    return window.api.fs.onFsChanged(onPayload)
  }

  const listener: RuntimeFileWatchListener = { onPayload, onError }
  const key = getSharedRuntimeFileWatchKey(
    target.environmentId,
    context.worktreeId,
    context.worktreePath
  )
  let shared = sharedRuntimeFileWatches.get(key)
  if (!shared) {
    shared = createSharedRuntimeFileWatch(key, target, context.worktreeId, context.worktreePath)
    sharedRuntimeFileWatches.set(key, shared)
  }
  shared.listeners.add(listener)
  try {
    await shared.start
  } catch (err) {
    shared.listeners.delete(listener)
    throw err
  }

  return () => {
    const current = sharedRuntimeFileWatches.get(key)
    if (!current) {
      return
    }
    current.listeners.delete(listener)
    if (current.listeners.size === 0) {
      closeSharedRuntimeFileWatch(key, current)
    }
  }
}

function createSharedRuntimeFileWatch(
  key: string,
  target: { kind: 'environment'; environmentId: string },
  worktreeId: string,
  worktreePath: string
): SharedRuntimeFileWatch {
  const shared: SharedRuntimeFileWatch = {
    target,
    worktreeId,
    listeners: new Set(),
    start: Promise.resolve(),
    unsubscribe: null,
    remoteSubscriptionId: null,
    keepStreamUntilReady: isWebRuntimeFileWatchSharedSocket(),
    closed: false
  }
  // Why: editor reloads and the Explorer can watch the same remote worktree.
  // Keep one runtime WebSocket/server watcher and fan out events in renderer.
  shared.start = window.api.runtimeEnvironments
    .subscribe(
      {
        selector: target.environmentId,
        method: 'files.watch',
        params: { worktree: toRuntimeWorktreeSelector(worktreeId) },
        timeoutMs: 15_000
      },
      {
        onResponse: (response) => {
          handleSharedRuntimeFileWatchResponse(shared, worktreePath, response)
        },
        onError: (error) => {
          notifySharedRuntimeFileWatchError(shared, new Error(error.message))
        },
        onClose: () => {
          if (sharedRuntimeFileWatches.get(key) === shared) {
            sharedRuntimeFileWatches.delete(key)
          }
          shared.closed = true
          shared.unsubscribe = null
        }
      }
    )
    .then((subscription) => {
      shared.unsubscribe = subscription.unsubscribe
      if (shared.closed || sharedRuntimeFileWatches.get(key) !== shared) {
        subscription.unsubscribe()
        shared.unsubscribe = null
        if (!shared.keepStreamUntilReady) {
          unwatchSharedRuntimeFileWatch(shared)
        }
      }
    })
    .catch((err) => {
      if (sharedRuntimeFileWatches.get(key) === shared) {
        sharedRuntimeFileWatches.delete(key)
      }
      shared.closed = true
      notifySharedRuntimeFileWatchError(shared, err instanceof Error ? err : new Error(String(err)))
      throw err
    })
  return shared
}

function handleSharedRuntimeFileWatchResponse(
  shared: SharedRuntimeFileWatch,
  worktreePath: string,
  response: unknown
): void {
  try {
    const event = unwrapRuntimeRpcResult<RuntimeFileWatchEvent>(
      response as RuntimeRpcResponse<RuntimeFileWatchEvent>
    )
    if (event.type === 'ready') {
      shared.remoteSubscriptionId = event.subscriptionId
      if (shared.closed) {
        shared.unsubscribe?.()
        shared.unsubscribe = null
        if (!shared.keepStreamUntilReady) {
          unwatchSharedRuntimeFileWatch(shared)
        }
      }
    } else if (event.type === 'changed') {
      for (const listener of Array.from(shared.listeners)) {
        listener.onPayload({ worktreePath, events: event.events })
      }
    }
  } catch (err) {
    notifySharedRuntimeFileWatchError(shared, err instanceof Error ? err : new Error(String(err)))
  }
}

function notifySharedRuntimeFileWatchError(shared: SharedRuntimeFileWatch, error: Error): void {
  for (const listener of Array.from(shared.listeners)) {
    listener.onError?.(error)
  }
}

function closeSharedRuntimeFileWatch(key: string, shared: SharedRuntimeFileWatch): void {
  if (shared.closed) {
    return
  }
  shared.closed = true
  sharedRuntimeFileWatches.delete(key)
  if (shared.keepStreamUntilReady) {
    // Why: WebRuntimeClient owns shared-socket file-watch cleanup, including
    // pre-ready fallback timers and late-ready files.unwatch.
    shared.unsubscribe?.()
    shared.unsubscribe = null
    return
  }
  shared.unsubscribe?.()
  shared.unsubscribe = null
  unwatchSharedRuntimeFileWatch(shared)
}

function isWebRuntimeFileWatchSharedSocket(): boolean {
  return Boolean((globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__)
}

function unwatchSharedRuntimeFileWatch(shared: SharedRuntimeFileWatch): void {
  if (!shared.remoteSubscriptionId) {
    return
  }
  void callRuntimeRpc(
    shared.target,
    'files.unwatch',
    { subscriptionId: shared.remoteSubscriptionId },
    { timeoutMs: 5_000 }
  ).catch(() => {})
}

export async function runtimePathExists(
  context: RuntimeFileOperationArgs,
  absolutePath: string
): Promise<boolean> {
  const remoteArgs = getRemoteFileArgs(context, absolutePath)
  if (!remoteArgs) {
    assertLocalFilesystemFallbackAllowed(context)
    return window.api.fs.pathExists({
      filePath: absolutePath,
      connectionId: context.connectionId
    })
  }

  try {
    await callRuntimeRpc(
      remoteArgs.target,
      'files.stat',
      { worktree: remoteArgs.worktreeSelector, relativePath: remoteArgs.relativePath },
      { timeoutMs: 15_000 }
    )
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
    if (
      message.includes('enoent') ||
      message.includes('not found') ||
      message.includes('no such file')
    ) {
      return false
    }
    throw err
  }
}

export function isRemoteRuntimeFileOperation(
  context: RuntimeFileOperationArgs,
  path: string
): boolean {
  return getRemoteFileArgs(context, path) !== null
}

function canReadRelativeRuntimeFile(relativePath: string | undefined): relativePath is string {
  return Boolean(relativePath && relativePath.trim() && !isAbsolutePathLike(relativePath))
}

function isAbsolutePathLike(value: string): boolean {
  return value.startsWith('/') || isWindowsAbsolutePathLike(value)
}

function getRemoteFileArgs(
  context: RuntimeFileOperationArgs,
  absolutePath: string
): {
  target: ReturnType<typeof getActiveRuntimeTarget> & { kind: 'environment' }
  worktreeId: string
  worktreeSelector: string
  relativePath: string
} | null {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind !== 'environment' || !context.worktreeId) {
    return null
  }
  const relativePath = getRelativePathInsideWorktree(context.worktreePath, absolutePath)
  if (relativePath === null) {
    return null
  }
  return {
    target,
    worktreeId: context.worktreeId,
    worktreeSelector: toRuntimeWorktreeSelector(context.worktreeId),
    relativePath
  }
}

function hasRemoteRuntimeOwner(context: RuntimeFileOperationArgs): boolean {
  return (
    getActiveRuntimeTarget(context.settings).kind === 'environment' && Boolean(context.worktreeId)
  )
}

function assertLocalFilesystemFallbackAllowed(context: RuntimeFileOperationArgs): void {
  if (hasRemoteRuntimeOwner(context)) {
    throw new Error('Remote file is outside the owning runtime worktree')
  }
}

function getRelativePathInsideWorktree(
  worktreePath: string | null | undefined,
  absolutePath: string
): string | null {
  if (!worktreePath) {
    return null
  }
  return relativePathInsideRoot(worktreePath, absolutePath)
}

async function deconflictRuntimeImportName(
  context: RuntimeFileOperationArgs,
  destinationDir: string,
  originalName: string,
  reservedNames: Set<string>
): Promise<string> {
  if (
    !(await runtimePathExists(context, joinPath(destinationDir, originalName))) &&
    !reservedNames.has(originalName)
  ) {
    return originalName
  }

  const dotIndex = originalName.lastIndexOf('.')
  const hasMeaningfulExt = dotIndex > 0
  const stem = hasMeaningfulExt ? originalName.slice(0, dotIndex) : originalName
  const ext = hasMeaningfulExt ? originalName.slice(dotIndex) : ''
  let candidate = `${stem} copy${ext}`
  if (
    !(await runtimePathExists(context, joinPath(destinationDir, candidate))) &&
    !reservedNames.has(candidate)
  ) {
    return candidate
  }

  let counter = 2
  while (counter < 10000) {
    candidate = `${stem} copy ${counter}${ext}`
    if (
      !(await runtimePathExists(context, joinPath(destinationDir, candidate))) &&
      !reservedNames.has(candidate)
    ) {
      return candidate
    }
    counter += 1
  }
  throw new Error(`Could not generate a unique name for '${basename(originalName)}'`)
}

function joinRuntimeRelativePath(basePath: string, relativePath: string): string {
  const normalizedBase = normalizeRelativePath(basePath)
  const normalizedRelative = normalizeRelativePath(relativePath)
  if (!normalizedBase) {
    return normalizedRelative
  }
  if (!normalizedRelative) {
    return normalizedBase
  }
  return `${normalizedBase}/${normalizedRelative}`
}

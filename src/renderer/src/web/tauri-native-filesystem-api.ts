import type { FilesystemApi } from '../../../preload/api/filesystem/filesystem-api'
import type {
  ImportItemResult,
  ResolveDroppedPathsResult
} from '../../../shared/file-import/filesystem-import-result'
import type {
  RuntimeUploadFileStreamRequest,
  StagedRuntimeUploadSource as StagedExternalImportSource
} from '../../../shared/file-import/runtime-upload-staging-contract'
import type { RuntimeClientTarget } from '../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { callRuntimeRpc } from '../runtime/rpc/calls/runtime-rpc-call'
import { uploadPathsToAgentSessionAttachments } from './tauri-native-attachment-upload'
import { requireActiveEnvironment } from './runtime/client/web-runtime-session'
import {
  createTauriNativeFilesystemReadApi,
  type NativeFilesystemFallback
} from './tauri-native-filesystem-read-api'
import { invokeNative, invokePlugin, isTauriNativeHost } from './tauri-native-host'
import { translate } from '../i18n/i18n'

const RUNTIME_UPLOAD_CHUNK_BYTES = 384 * 1024
const RUNTIME_UPLOAD_CHUNK_TIMEOUT_MS = 30_000

type NativeFileChunk = {
  contentBase64: string
  byteLength: number
}

/** Native file ownership for Tauri's local runtime and structured chat uploads. */
export function createTauriNativeFilesystemApi(
  fallback?: NativeFilesystemFallback
): Partial<FilesystemApi['fs']> {
  if (!isTauriNativeHost()) {
    return {}
  }
  return {
    ...createTauriNativeFilesystemReadApi(fallback),
    downloadFolder: downloadTauriSshFolder,
    saveDownloadedFile,
    startDownloadedFile,
    appendDownloadedFileChunk: ({ transferId, contentBase64 }) =>
      invokeNative('poc_append_downloaded_file_chunk', { transferId, contentBase64 }),
    finishDownloadedFile: ({ transferId }) =>
      invokeNative('poc_finish_downloaded_file', { transferId }),
    cancelDownloadedFile: ({ transferId }) =>
      invokeNative('poc_cancel_downloaded_file', { transferId }),
    importExternalPaths: importExternalPaths,
    stageExternalPathsForRuntimeUpload: ({ sourcePaths }) =>
      invokeNative<{ sources: StagedExternalImportSource[] }>('poc_stage_external_paths', {
        args: { sourcePaths }
      }),
    uploadExternalFileToRuntime: uploadExternalFileToRuntime,
    resolveDroppedPathsForAgent: resolveDroppedPathsForAgent,
    uploadPathsToAgentSessionAttachments: (args) =>
      uploadPathsToAgentSessionAttachments(readExternalFileChunk, args)
  }
}

async function downloadTauriSshFolder(args: {
  dirPath: string
  connectionId: string
}): Promise<{ canceled: true } | { canceled: false; destinationPath: string }> {
  const parentPath = await invokePlugin<string | string[] | null>('dialog', 'open', {
    options: {
      title: translate(
        'auto.web.tauriNative.dialog.selectDownloadDestination',
        'Select download destination'
      ),
      multiple: false,
      directory: true
    }
  })
  const destinationParent = Array.isArray(parentPath) ? parentPath[0] : parentPath
  if (!destinationParent) {
    return { canceled: true }
  }

  const started = await invokeNative<{
    transferId: string
    destinationPath: string
    tempPath: string
  }>('poc_start_downloaded_folder', {
    args: {
      parentPath: destinationParent,
      suggestedName: sanitizeFolderDownloadName(args.dirPath)
    }
  })
  let finished = false
  try {
    await callRuntimeRpc(
      { kind: 'environment', environmentId: requireActiveEnvironment().id },
      'ssh.downloadFolder',
      {
        targetId: args.connectionId,
        dirPath: args.dirPath,
        destinationPath: started.tempPath
      },
      { timeoutMs: 30 * 60 * 1000 }
    )
    const result = await invokeNative<{ destinationPath: string }>('poc_finish_downloaded_folder', {
      transferId: started.transferId
    })
    finished = true
    return { canceled: false, destinationPath: result.destinationPath }
  } finally {
    if (!finished) {
      await invokeNative('poc_cancel_downloaded_folder', {
        transferId: started.transferId
      }).catch(() => {})
    }
  }
}

function sanitizeFolderDownloadName(dirPath: string): string {
  const trimmed = dirPath.replace(/[\\/]+$/u, '')
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const name = trimmed
    .slice(separator + 1)
    .replace(/[<>:"/\\|?*]/gu, '_')
    .replace(/[. ]+$/u, '')
  return name || 'download'
}

async function importExternalPaths(args: {
  sourcePaths: string[]
  destDir: string
  connectionId?: string
  ensureDir?: boolean
  access?: Parameters<NonNullable<FilesystemApi['fs']['importExternalPaths']>>[0]['access']
}): Promise<{ results: ImportItemResult[] }> {
  if (args.connectionId !== undefined) {
    return {
      results: args.sourcePaths.map((sourcePath) => ({
        sourcePath,
        status: 'failed',
        reason: 'SSH file imports are not available in the Tauri host yet.'
      }))
    }
  }
  return invokeNative<{ results: ImportItemResult[] }>('poc_import_external_paths', {
    args: {
      sourcePaths: args.sourcePaths,
      destDir: args.destDir,
      ensureDir: args.ensureDir,
      access: args.access
    }
  })
}

async function chooseDownloadDestination(suggestedName: string): Promise<string | null> {
  const safeName = suggestedName.replace(/[<>:"/\\|?*]/g, '_').trim()
  return invokePlugin<string | null>('dialog', 'save', {
    options: { defaultPath: safeName || 'download' }
  })
}

async function saveDownloadedFile(args: {
  suggestedName: string
  content: string
  encoding: 'utf8' | 'base64'
}): Promise<{ canceled: true } | { canceled: false; destinationPath: string }> {
  const destinationPath = await chooseDownloadDestination(args.suggestedName)
  if (!destinationPath) {
    return { canceled: true }
  }
  const result = await invokeNative<{ destinationPath: string }>('poc_save_downloaded_file', {
    args: { destinationPath, content: args.content, encoding: args.encoding }
  })
  return { canceled: false, destinationPath: result.destinationPath }
}

async function startDownloadedFile(args: {
  suggestedName: string
}): Promise<{ canceled: true } | { canceled: false; transferId: string; destinationPath: string }> {
  const destinationPath = await chooseDownloadDestination(args.suggestedName)
  if (!destinationPath) {
    return { canceled: true }
  }
  const result = await invokeNative<{ transferId: string; destinationPath: string }>(
    'poc_start_downloaded_file',
    { args: { destinationPath } }
  )
  return { canceled: false, ...result }
}

async function uploadExternalFileToRuntime(
  args: RuntimeUploadFileStreamRequest
): Promise<{ byteLength: number }> {
  const target: RuntimeClientTarget = args.environmentId
    ? { kind: 'environment', environmentId: args.environmentId }
    : { kind: 'local' }
  let offset = 0
  if (args.expected.byteLength === 0) {
    await writeRuntimeChunk(target, args, '', false)
    return { byteLength: 0 }
  }
  while (offset < args.expected.byteLength) {
    const requestedLength = Math.min(RUNTIME_UPLOAD_CHUNK_BYTES, args.expected.byteLength - offset)
    const chunk = await readExternalFileChunk({
      sourceRootPath: args.sourceRootPath,
      entryRelativePath: args.entryRelativePath,
      expected: args.expected,
      offset,
      length: requestedLength
    })
    if (chunk.byteLength === 0) {
      throw new Error('File ended before the staged upload was complete.')
    }
    await writeRuntimeChunk(target, args, chunk.contentBase64, offset > 0)
    offset += chunk.byteLength
  }
  return { byteLength: offset }
}

async function writeRuntimeChunk(
  target: RuntimeClientTarget,
  args: RuntimeUploadFileStreamRequest,
  contentBase64: string,
  append: boolean
): Promise<void> {
  await callRuntimeRpc(
    target,
    'files.writeBase64Chunk',
    {
      worktree: args.worktree,
      relativePath: args.relativePath,
      contentBase64,
      append,
      expectedSshTargetId: args.expectedSshTargetId,
      expectedSshConnectionGeneration: args.expectedSshConnectionGeneration,
      expectedExecutionHostId: args.expectedExecutionHostId
    },
    {
      timeoutMs: RUNTIME_UPLOAD_CHUNK_TIMEOUT_MS,
      expectedEnvironmentPairingRevision: args.expectedEnvironmentPairingRevision,
      expectedEnvironmentRuntimeId: args.expectedEnvironmentRuntimeId
    }
  )
}

async function readExternalFileChunk(args: {
  sourceRootPath: string
  entryRelativePath: string
  expected: RuntimeUploadFileStreamRequest['expected']
  offset: number
  length: number
}): Promise<NativeFileChunk> {
  return invokeNative<NativeFileChunk>('poc_read_external_file_chunk', { args })
}

async function resolveDroppedPathsForAgent(args: {
  paths: string[]
  worktreePath: string
  connectionId?: string
}): Promise<ResolveDroppedPathsResult> {
  if (args.connectionId !== undefined) {
    return {
      resolvedPaths: [],
      skipped: [],
      failed: args.paths.map((sourcePath) => ({
        sourcePath,
        reason: 'SSH file drops are not available in the Tauri host yet.'
      }))
    }
  }
  const resolvedPaths = await invokeNative<string[]>('poc_validate_dropped_paths', {
    paths: args.paths
  })
  return { resolvedPaths, skipped: [], failed: [] }
}

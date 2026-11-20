import {
  AGENT_SESSION_ATTACHMENT_CHUNK_BYTES,
  AGENT_SESSION_ATTACHMENT_MAX_BYTES,
  type AgentSessionAttachmentPathUploadResult,
  type AgentSessionAttachmentUploadCommitResult,
  type AgentSessionAttachmentUploadTarget
} from '../../../shared/agent-session/agent-session-attachments'
import type {
  StagedRuntimeUploadEntry as StagedExternalImportEntry,
  StagedRuntimeUploadSource as StagedExternalImportSource
} from '../../../shared/file-import/runtime-upload-staging-contract'
import type { RuntimeClientTarget } from '../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { callRuntimeRpc } from '../runtime/rpc/calls/runtime-rpc-call'
import { invokeNative } from './tauri-native-host'

const RUNTIME_UPLOAD_CHUNK_TIMEOUT_MS = 30_000

type NativeFileChunk = { contentBase64: string; byteLength: number }
type ReadExternalFileChunk = (args: {
  sourceRootPath: string
  entryRelativePath: string
  expected: Extract<StagedExternalImportEntry, { kind: 'file' }>
  offset: number
  length: number
}) => Promise<NativeFileChunk>

export async function uploadPathsToAgentSessionAttachments(
  readExternalFileChunk: ReadExternalFileChunk,
  args: AgentSessionAttachmentUploadTarget & { paths: string[] }
): Promise<AgentSessionAttachmentPathUploadResult> {
  const staged = await invokeNative<{ sources: StagedExternalImportSource[] }>(
    'poc_stage_external_paths',
    { args: { sourcePaths: args.paths } }
  )
  const result: AgentSessionAttachmentPathUploadResult = { uploaded: [], skipped: [], failed: [] }
  for (const source of staged.sources) {
    await uploadStagedAttachment(readExternalFileChunk, args, source, result)
  }
  return result
}

async function uploadStagedAttachment(
  readExternalFileChunk: ReadExternalFileChunk,
  context: AgentSessionAttachmentUploadTarget,
  source: StagedExternalImportSource,
  result: AgentSessionAttachmentPathUploadResult
): Promise<void> {
  if (source.status === 'skipped') {
    result.skipped.push({ sourcePath: source.sourcePath, reason: source.reason })
    return
  }
  if (source.status === 'failed') {
    result.failed.push({ sourcePath: source.sourcePath, reason: source.reason })
    return
  }
  if (source.kind !== 'file') {
    result.skipped.push({ sourcePath: source.sourcePath, reason: 'unsupported' })
    return
  }
  const entry = source.entries[0]
  if (!entry || entry.kind !== 'file') {
    result.failed.push({ sourcePath: source.sourcePath, reason: 'Invalid staged file.' })
    return
  }
  if (entry.byteLength > AGENT_SESSION_ATTACHMENT_MAX_BYTES) {
    result.failed.push({
      sourcePath: source.sourcePath,
      reason: 'The file exceeds the 50 MB chat attachment limit.'
    })
    return
  }
  try {
    const stored = await uploadAttachment(
      readExternalFileChunk,
      context,
      source.name,
      source.sourcePath,
      entry.byteLength,
      entry
    )
    result.uploaded.push({ sourcePath: source.sourcePath, path: stored.path })
  } catch (error) {
    result.failed.push({
      sourcePath: source.sourcePath,
      reason: error instanceof Error ? error.message : String(error)
    })
  }
}

async function uploadAttachment(
  readExternalFileChunk: ReadExternalFileChunk,
  context: AgentSessionAttachmentUploadTarget,
  name: string,
  sourceRootPath: string,
  byteLength: number,
  expected: Extract<StagedExternalImportEntry, { kind: 'file' }>
): Promise<AgentSessionAttachmentUploadCommitResult> {
  const target: RuntimeClientTarget = { kind: 'environment', environmentId: context.environmentId }
  const started = await callRuntimeRpc<{ uploadId: string }>(
    target,
    'agentSessionAttachment.uploadStart',
    { sessionId: context.sessionId, name, byteLength },
    runtimeAttachmentOptions(context)
  )
  try {
    if (byteLength === 0) {
      await appendAttachmentChunk(target, context, started.uploadId, '', 0)
    } else {
      let offset = 0
      while (offset < byteLength) {
        const chunk = await readExternalFileChunk({
          sourceRootPath,
          entryRelativePath: '',
          expected,
          offset,
          length: Math.min(AGENT_SESSION_ATTACHMENT_CHUNK_BYTES, byteLength - offset)
        })
        if (chunk.byteLength === 0) {
          throw new Error('File ended before the attachment upload was complete.')
        }
        await appendAttachmentChunk(target, context, started.uploadId, chunk.contentBase64, offset)
        offset += chunk.byteLength
      }
    }
    return await callRuntimeRpc<AgentSessionAttachmentUploadCommitResult>(
      target,
      'agentSessionAttachment.uploadCommit',
      { uploadId: started.uploadId },
      runtimeAttachmentOptions(context)
    )
  } catch (error) {
    await callRuntimeRpc(
      target,
      'agentSessionAttachment.uploadAbort',
      { uploadId: started.uploadId },
      { ...runtimeAttachmentOptions(context), signal: undefined }
    ).catch(() => {})
    throw error
  }
}

async function appendAttachmentChunk(
  target: RuntimeClientTarget,
  context: AgentSessionAttachmentUploadTarget,
  uploadId: string,
  contentBase64: string,
  offset: number
): Promise<void> {
  await callRuntimeRpc(
    target,
    'agentSessionAttachment.uploadAppend',
    { uploadId, offset, contentBase64 },
    runtimeAttachmentOptions(context)
  )
}

function runtimeAttachmentOptions(context: AgentSessionAttachmentUploadTarget) {
  return {
    timeoutMs: RUNTIME_UPLOAD_CHUNK_TIMEOUT_MS,
    expectedEnvironmentPairingRevision: context.expectedEnvironmentPairingRevision,
    expectedEnvironmentRuntimeId: context.expectedEnvironmentRuntimeId
  }
}

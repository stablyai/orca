import {
  AGENT_SESSION_ATTACHMENT_CHUNK_BYTES,
  AGENT_SESSION_ATTACHMENT_MAX_BYTES,
  agentSessionAttachmentAppends,
  agentSessionPastedImageName,
  base64DecodedByteLength,
  type AgentSessionAttachmentPathUploadResult,
  type AgentSessionAttachmentUploadCommitResult,
  type AgentSessionAttachmentUploadTarget
} from '../../../../shared/agent-session-attachments'
import { encodeBase64Bytes } from '@/lib/base64-bytes'
import { takeBrowserAttachmentFile } from '@/lib/browser-attachment-files'
import { callEnvironmentEnvelope } from './web-runtime-calls'
import { resolveEnvironment } from './web-runtime-session'
import { createBrowserUuid } from '@/lib/browser-uuid'

const ATTACHMENT_CALL_TIMEOUT_MS = 30_000
const SERVER_CHANGED = 'The paired Orca server changed while the request was in progress.'

/** Every call goes to the server the paste was meant for, as its desktop counterpart does: a
 *  re-pair or a replaced server process ends the upload instead of storing it elsewhere. */
async function callPinned<TResult>(
  target: AgentSessionAttachmentUploadTarget,
  method: string,
  params: unknown
): Promise<TResult> {
  const environment = resolveEnvironment(target.environmentId)
  if (
    target.expectedEnvironmentPairingRevision !== undefined &&
    (environment.pairingRevision ?? environment.createdAt) !==
      target.expectedEnvironmentPairingRevision
  ) {
    throw new Error(SERVER_CHANGED)
  }
  const response = await callEnvironmentEnvelope<TResult>(
    environment.id,
    method,
    params,
    ATTACHMENT_CALL_TIMEOUT_MS
  )
  // A failure may come from this side and name no server process; a success always names one.
  const runtimeId = response._meta?.runtimeId ?? null
  if ((response.ok || runtimeId !== null) && runtimeId !== target.expectedEnvironmentRuntimeId) {
    throw new Error(SERVER_CHANGED)
  }
  if (!response.ok) {
    throw new Error(response.error.message || response.error.code)
  }
  return response.result
}

type AttachmentAppend = { offset: number; contentBase64: string }

/** Aborts a failed transfer so the server frees its slot; only on the same server, since an
 *  abort a re-pair refuses is left to that server's idle expiry. */
async function uploadWebAgentSessionAttachment(
  target: AgentSessionAttachmentUploadTarget,
  file: { name: string; byteLength: number },
  appends: AsyncIterable<AttachmentAppend> | Iterable<AttachmentAppend>
): Promise<AgentSessionAttachmentUploadCommitResult> {
  const { uploadId } = await callPinned<{ uploadId: string }>(
    target,
    'agentSessionAttachment.uploadStart',
    { sessionId: target.sessionId, name: file.name, byteLength: file.byteLength }
  )
  try {
    for await (const chunk of appends) {
      await callPinned(target, 'agentSessionAttachment.uploadAppend', { uploadId, ...chunk })
    }
    return await callPinned<AgentSessionAttachmentUploadCommitResult>(
      target,
      'agentSessionAttachment.uploadCommit',
      { uploadId }
    )
  } catch (error) {
    await callPinned(target, 'agentSessionAttachment.uploadAbort', { uploadId }).catch(() => {})
    throw error
  }
}

/** The browser client's paste into a structured chat: the same store the desktop client uses. */
export async function saveClipboardImageAsWebAgentSessionAttachment(
  contentBase64: string,
  target: AgentSessionAttachmentUploadTarget,
  name: string = agentSessionPastedImageName(Date.now(), createBrowserUuid())
): Promise<string> {
  const stored = await uploadWebAgentSessionAttachment(
    target,
    { name, byteLength: base64DecodedByteLength(contentBase64) },
    agentSessionAttachmentAppends(contentBase64)
  )
  return stored.path
}

// Reads one chunk at a time, so a large file is never held as base64 whole.
async function* browserFileAppends(file: Blob): AsyncGenerator<AttachmentAppend> {
  let offset = 0
  do {
    const slice = file.slice(offset, offset + AGENT_SESSION_ATTACHMENT_CHUNK_BYTES)
    yield { offset, contentBase64: encodeBase64Bytes(new Uint8Array(await slice.arrayBuffer())) }
    offset += AGENT_SESSION_ATTACHMENT_CHUNK_BYTES
  } while (offset < file.size)
}

const MAX_MEGABYTES = AGENT_SESSION_ATTACHMENT_MAX_BYTES / (1024 * 1024)

/** The browser's picked and dropped files, named by the tokens that hold them, uploaded into the
 *  chat's store on its paired server in input order, as the desktop uploads local paths. */
export async function uploadBrowserFilesToWebAgentSessionAttachments(
  args: AgentSessionAttachmentUploadTarget & { paths: readonly string[] }
): Promise<AgentSessionAttachmentPathUploadResult> {
  const { paths, ...target } = args
  const result: AgentSessionAttachmentPathUploadResult = { uploaded: [], skipped: [], failed: [] }
  for (const sourcePath of paths) {
    const file = takeBrowserAttachmentFile(sourcePath)
    if (!file) {
      result.failed.push({ sourcePath, reason: 'Attach the file again.' })
      continue
    }
    if (file.size > AGENT_SESSION_ATTACHMENT_MAX_BYTES) {
      result.failed.push({
        sourcePath,
        reason: `'${file.name}' is over the ${MAX_MEGABYTES} MB chat attachment limit`
      })
      continue
    }
    try {
      const stored = await uploadWebAgentSessionAttachment(
        target,
        { name: file.name, byteLength: file.size },
        browserFileAppends(file)
      )
      result.uploaded.push({ sourcePath, path: stored.path })
    } catch (error) {
      result.failed.push({
        sourcePath,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return result
}

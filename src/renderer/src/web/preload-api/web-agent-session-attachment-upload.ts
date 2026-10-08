import {
  AGENT_SESSION_ATTACHMENT_CHUNK_BASE64_CHARS,
  agentSessionPastedImageName,
  type AgentSessionAttachmentUploadCommitResult,
  type AgentSessionAttachmentUploadTarget
} from '../../../../shared/agent-session-attachments'
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

/** The browser client's paste into a structured chat: the same store the desktop client uses. */
export async function saveClipboardImageAsWebAgentSessionAttachment(
  contentBase64: string,
  target: AgentSessionAttachmentUploadTarget
): Promise<string> {
  const padding = contentBase64.endsWith('==') ? 2 : contentBase64.endsWith('=') ? 1 : 0
  const byteLength = (contentBase64.length / 4) * 3 - padding
  const { uploadId } = await callPinned<{ uploadId: string }>(
    target,
    'agentSessionAttachment.uploadStart',
    {
      sessionId: target.sessionId,
      name: agentSessionPastedImageName(Date.now(), createBrowserUuid()),
      byteLength
    }
  )
  try {
    // Chunks are a multiple of 4 base64 characters, so each starts on a byte boundary.
    for (
      let charOffset = 0;
      charOffset < Math.max(contentBase64.length, 1);
      charOffset += AGENT_SESSION_ATTACHMENT_CHUNK_BASE64_CHARS
    ) {
      await callPinned(target, 'agentSessionAttachment.uploadAppend', {
        uploadId,
        offset: (charOffset / 4) * 3,
        contentBase64: contentBase64.slice(
          charOffset,
          charOffset + AGENT_SESSION_ATTACHMENT_CHUNK_BASE64_CHARS
        )
      })
    }
    const stored = await callPinned<AgentSessionAttachmentUploadCommitResult>(
      target,
      'agentSessionAttachment.uploadCommit',
      { uploadId }
    )
    return stored.path
  } catch (error) {
    // Only to the same server: an abort a re-pair refuses is left to that server's idle expiry.
    await callPinned(target, 'agentSessionAttachment.uploadAbort', { uploadId }).catch(() => {})
    throw error
  }
}

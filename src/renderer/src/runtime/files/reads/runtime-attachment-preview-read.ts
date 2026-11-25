import type { RuntimeFilePreviewResult } from '../../../../../shared/file-content/runtime-file-read'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { RuntimeStatus } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { AGENT_SESSION_ATTACHMENT_MAX_BYTES } from '../../../../../shared/agent-session/agent-session-attachments'
import { AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY } from '../../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import { readAttachmentBase64InRanges } from '../../../../../shared/agent-session/agent-session-attachment-paged-read'
import { IMAGE_FILE_MIME_TYPES } from '../../../../../shared/file-preview/image-mime-types'
import { filePreviewExtension } from '../../../../../shared/file-preview/file-preview-kind'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '../../rpc/calls/runtime-rpc-result'
import { captureRuntimeEnvironmentRequestRevision } from '../../rpc/environment-revisions/runtime-environment-revision'

type EnvironmentTarget = Extract<RuntimeClientTarget, { kind: 'environment' }>

/** A paired server's stored chat attachment. One reply carries about 3 MB; a larger image is read in
 *  ranges from hosts that offer them, and older hosts keep their size error. */
export async function readRuntimeAttachmentPreview(
  target: EnvironmentTarget,
  path: string,
  pairingRevision: number | undefined
): Promise<RuntimeFilePreviewResult> {
  // Why: pinned before the first call, so a re-pair cannot move later ranges to another host.
  const expectedEnvironmentPairingRevision = captureRuntimeEnvironmentRequestRevision(
    target.environmentId,
    pairingRevision
  )
  const options = { timeoutMs: 15_000, expectedEnvironmentPairingRevision }
  try {
    return await callRuntimeRpc<RuntimeFilePreviewResult>(
      target,
      'agentSessionAttachment.read',
      { path },
      options
    )
  } catch (error) {
    const mimeType = IMAGE_FILE_MIME_TYPES[filePreviewExtension(path)]
    if (
      !(error instanceof RuntimeRpcCallError && error.message === 'file_too_large') ||
      !mimeType
    ) {
      throw error
    }
    const host = await callRuntimeRpc<RuntimeStatus>(target, 'status.get', undefined, options)
    if (!host.capabilities?.includes(AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY)) {
      throw error
    }
    const content = await readAttachmentBase64InRanges(
      (request) =>
        callRuntimeRpc(target, 'agentSessionAttachment.readTextChunk', request, {
          ...options,
          expectedEnvironmentRuntimeId: host.runtimeId
        }),
      path,
      AGENT_SESSION_ATTACHMENT_MAX_BYTES
    )
    if (content === null) {
      throw error
    }
    return { content, isBinary: true, isImage: true, mimeType }
  }
}

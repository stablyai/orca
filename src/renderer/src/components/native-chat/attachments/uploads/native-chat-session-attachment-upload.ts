import type { NativeChatRuntimeSessionAttachmentOwner } from './native-chat-attachment-owner'
import type {
  AgentSessionAttachmentUploadTarget,
  AgentSessionAttachmentPathUploadResult
} from '../../../../../../shared/agent-session/agent-session-attachments'
import { callRuntimeRpc } from '../../../../runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeStatus } from '../../../../../../shared/runtime-session-contracts'
import { AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/agent-session-runtime-capabilities'
import { translate } from '../../../../i18n/i18n'
import { AGENT_SESSION_WRITE_NOTICE_COPY } from '../../../../../../shared/agent-session/failures/agent-session-write-notice-copy'
import { useAppStore } from '../../../../store/index'
import {
  isRuntimeHostContactRevoked,
  lastVerifiedRuntimeStatus
} from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'

/** Check attachment capability and receiving process before uploading; older hosts need an update, never a client-local path. */
export async function prepareNativeChatSessionAttachmentUpload(
  owner: NativeChatRuntimeSessionAttachmentOwner
): Promise<
  { ok: true; target: AgentSessionAttachmentUploadTarget } | { ok: false; notice: string }
> {
  const status = await callRuntimeRpc<RuntimeStatus>(
    { kind: 'environment', environmentId: owner.environmentId },
    'status.get',
    undefined,
    { timeoutMs: 15_000, expectedEnvironmentPairingRevision: owner.pairingRevision }
  )
  if (!status.capabilities?.includes(AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY)) {
    // The same words as any write a server too old for it refuses.
    return {
      ok: false,
      notice: translate(
        'components.native-chat.writeNotice.unsupported',
        AGENT_SESSION_WRITE_NOTICE_COPY.unsupported
      )
    }
  }
  return {
    ok: true,
    target: {
      environmentId: owner.environmentId,
      sessionId: owner.sessionId,
      expectedEnvironmentPairingRevision: owner.pairingRevision,
      expectedEnvironmentRuntimeId: status.runtimeId
    }
  }
}

/** Upload to the paired chat store; chips own progress display and callers report failures. */
export function uploadNativeChatSessionAttachmentPaths(
  paths: string[],
  target: AgentSessionAttachmentUploadTarget
): Promise<AgentSessionAttachmentPathUploadResult> {
  return window.api.fs.uploadPathsToAgentSessionAttachments({ ...target, paths })
}

/** The runtime status slice evicts replaced peers and accepts only current pairing snapshots. */
export function cachedNativeChatPasteUploadTarget(
  owner: NativeChatRuntimeSessionAttachmentOwner
): AgentSessionAttachmentUploadTarget | null {
  const entry = useAppStore.getState().runtimeStatusByEnvironmentId.get(owner.environmentId)
  const status = isRuntimeHostContactRevoked(entry) ? null : lastVerifiedRuntimeStatus(entry)
  if (!status?.capabilities?.includes(AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY)) {
    return null
  }
  return {
    environmentId: owner.environmentId,
    sessionId: owner.sessionId,
    expectedEnvironmentPairingRevision: owner.pairingRevision,
    expectedEnvironmentRuntimeId: status.runtimeId
  }
}

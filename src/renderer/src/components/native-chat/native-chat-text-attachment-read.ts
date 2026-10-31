import { useAppStore } from '@/store'
import { getPairedWebClientEnvironmentId } from '@/lib/paired-web-client-host'
import { sharedPromiseSettlementWaiters } from '../../../../shared/promise-settlement-waiters'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  captureRuntimeEnvironmentRequestRevision,
  getRuntimeEnvironmentRevision
} from '@/runtime/runtime-environment-revision'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { AttachmentTextRead } from '../../../../shared/attachment-text-source'
import { AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY } from '../../../../shared/agent-session-runtime-capabilities'

export function createChatAttachmentReader(
  target: RuntimeClientTarget | null,
  text?: string
): AttachmentTextRead {
  if (text !== undefined) {
    const blob = new Blob([text])
    return async ({ offset, length }) => {
      const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())
      return {
        snapshot: '0'.repeat(64),
        size: blob.size,
        bytesRead: bytes.length,
        contentBase64: btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')),
        eof: offset + bytes.length === blob.size
      }
    }
  }
  if (!target) {
    return async () => {
      throw new Error('The attachment host is unavailable. Reconnect and retry.')
    }
  }
  const environmentId =
    target.kind === 'local' ? getPairedWebClientEnvironmentId(useAppStore.getState()) : null
  if (environmentId) {
    target = { kind: 'environment', environmentId }
  }
  const owner = target
  const wait = <T>(promise: Promise<T>, signal?: AbortSignal) =>
    sharedPromiseSettlementWaiters(promise).wait({ signal, timeoutMs: 15_000 })
  const expectedEnvironmentPairingRevision =
    owner.kind === 'environment'
      ? captureRuntimeEnvironmentRequestRevision(owner.environmentId)
      : undefined
  let status: Promise<RuntimeStatus> | undefined
  const assertCurrent = () => {
    if (
      owner.kind === 'environment' &&
      getRuntimeEnvironmentRevision(owner.environmentId) !== expectedEnvironmentPairingRevision
    ) {
      throw new Error('Connection changed. Close this attachment and reopen it.')
    }
  }
  return Object.assign(
    async (request: Parameters<AttachmentTextRead>[0], signal?: AbortSignal) => {
      signal?.throwIfAborted()
      assertCurrent()
      if (!request.expectedSnapshot) {
        status = undefined
      }
      status ??= callRuntimeRpc<RuntimeStatus>(owner, 'status.get', undefined, {
        expectedEnvironmentPairingRevision,
        signal,
        timeoutMs: 15_000
      })
      const host = await wait(status, signal)
      signal?.throwIfAborted()
      assertCurrent()
      if (!host.capabilities?.includes(AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY)) {
        throw new Error(
          'This host cannot open text attachments yet. Update Orca on that host, then retry.'
        )
      }
      try {
        return await wait(
          callRuntimeRpc(owner, 'agentSessionAttachment.readTextChunk', request, {
            expectedEnvironmentPairingRevision,
            expectedEnvironmentRuntimeId: host.runtimeId,
            timeoutMs: 15_000,
            signal
          }),
          signal
        )
      } catch {
        signal?.throwIfAborted()
        throw new Error(
          'Unable to read this attachment on its host. Reconnect and try again. The file may have been removed or changed.'
        )
      }
    },
    { assertCurrent }
  )
}

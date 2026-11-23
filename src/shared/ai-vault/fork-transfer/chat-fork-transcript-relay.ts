import {
  AiVaultAppendChatForkImportResultSchema,
  AiVaultBeginChatForkImportResultSchema,
  AiVaultCommitChatForkImportResultSchema,
  AiVaultExportChatForkResultSchema,
  AiVaultReadChatForkExportResultSchema,
  type AiVaultCommitChatForkImportResult,
  type AiVaultExportChatForkRequest,
  type AiVaultExportChatForkResult
} from '../../rpc-contract/ai-vault/ai-vault-fork-transfer-params'
import {
  CHAT_FORK_TRANSFER_CHUNK_BYTES,
  chatForkTransferErrorCode
} from './chat-fork-transfer-limits'

/** One RPC to a host; the relay parses every reply, trusting neither side. */
export type ChatForkRelayCall = (
  method: string,
  params: Record<string, unknown>
) => Promise<unknown>

export type ChatForkTranscriptRelayInput = {
  source: AiVaultExportChatForkRequest
  /** A worktree selector on the target host, e.g. `id:<worktreeId>`. */
  targetWorktree: string
  sourceCall: ChatForkRelayCall
  targetCall: ChatForkRelayCall
  signal?: AbortSignal
  onProgress?: (doneBytes: number, totalBytes: number) => void
}

export type ChatForkTranscriptRelayResult = {
  exported: AiVaultExportChatForkResult
  /** Pass to session.tabs.createTerminal as `sourceChatImport.importId` for a terminal launch. */
  importId: string
  placed: AiVaultCommitChatForkImportResult
}

/** Copies a chat's cut transcript from the source host to the target host through this client,
 *  holding one chunk at a time. The export is always released; a failed import is cancelled.
 *  An append or commit whose reply is lost is sent once more: the target acknowledges a chunk it
 *  already holds and replays a commit it already placed, so a retry never duplicates. */
export async function relayChatForkTranscript(
  input: ChatForkTranscriptRelayInput
): Promise<ChatForkTranscriptRelayResult> {
  const { signal, sourceCall, targetCall } = input
  signal?.throwIfAborted()
  const exported = AiVaultExportChatForkResultSchema.parse(
    await sourceCall('aiVault.exportChatFork', input.source)
  )
  const total = exported.byteLength
  let importId: string | null = null
  let committed = false
  try {
    signal?.throwIfAborted()
    const begun = AiVaultBeginChatForkImportResultSchema.parse(
      await targetCall('aiVault.beginChatForkImport', {
        agent: 'claude',
        worktree: input.targetWorktree,
        byteLength: total,
        sha256: exported.sha256,
        sourceSessionId: exported.sourceSessionId,
        ...(exported.title ? { title: exported.title } : {})
      })
    )
    importId = begun.importId
    const chunkBytes = Math.min(
      exported.chunkBytes,
      begun.chunkBytes,
      CHAT_FORK_TRANSFER_CHUNK_BYTES
    )
    let offset = 0
    input.onProgress?.(0, total)
    while (offset < total) {
      signal?.throwIfAborted()
      const { bytesBase64 } = AiVaultReadChatForkExportResultSchema.parse(
        await sourceCall('aiVault.readChatForkExport', {
          exportId: exported.exportId,
          offset,
          length: Math.min(chunkBytes, total - offset)
        })
      )
      const next = offset + base64DecodedLength(bytesBase64)
      if (!Number.isInteger(next) || next <= offset || next > total) {
        throw new Error('chat_fork_transfer_integrity_failed')
      }
      signal?.throwIfAborted()
      const { acknowledgedOffset } = AiVaultAppendChatForkImportResultSchema.parse(
        await retryOnce(signal, () =>
          targetCall('aiVault.appendChatForkImport', { importId, offset, bytesBase64 })
        )
      )
      if (acknowledgedOffset !== next) {
        throw new Error('chat_fork_transfer_offset_mismatch')
      }
      offset = next
      input.onProgress?.(offset, total)
    }
    signal?.throwIfAborted()
    const placed = AiVaultCommitChatForkImportResultSchema.parse(
      await retryOnce(signal, () => targetCall('aiVault.commitChatForkImport', { importId }))
    )
    committed = true
    return { exported, importId, placed }
  } finally {
    const pendingImport = committed ? null : importId
    await Promise.allSettled([
      settle(() => sourceCall('aiVault.releaseChatForkExport', { exportId: exported.exportId })),
      ...(pendingImport
        ? [settle(() => targetCall('aiVault.cancelChatForkImport', { importId: pendingImport }))]
        : [])
    ])
  }
}

/** One more try after a transport failure; a host's own refusal (a known code) is final. */
async function retryOnce(signal: AbortSignal | undefined, call: () => Promise<unknown>) {
  try {
    return await call()
  } catch (error) {
    if (chatForkTransferErrorCode(error) || signal?.aborted) {
      throw error
    }
    return call()
  }
}

function settle(call: () => Promise<unknown>): Promise<unknown> {
  return Promise.resolve().then(call)
}

function base64DecodedLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

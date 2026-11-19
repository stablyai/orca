import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/rpc/targets/runtime-client-target'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { startStructuredAgentLaunch } from '@/lib/agent-session/launch/structured-agent-session-launch'
import { captureStructuredLaunchSurfaceAddress } from '@/lib/agent-session/launch/structured-agent-session-launch-surface'
import { relayChatForkTranscript } from '../../../../../../../shared/ai-vault/fork-transfer/chat-fork-transcript-relay'
import {
  CHAT_FORK_TRANSFER_MAX_BYTES,
  chatForkTransferErrorCode
} from '../../../../../../../shared/ai-vault/fork-transfer/chat-fork-transfer-limits'
import type { AiVaultCommitChatForkImportResult } from '../../../../../../../shared/rpc-contract/ai-vault/ai-vault-fork-transfer-params'
import { createNonSecureContextUuid } from '../../../../../../../shared/identifiers/non-secure-context-uuid'
import type { ExecutionHostId } from '../../../../../../../shared/execution-host/execution-host'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { resumeClaudeCopyInNewTerminalTab } from '../native-chat-terminal-fork-launch'
import { nameForkedStructuredChat } from '@/runtime/native-chat/naming/structured-chat-fork-name'
import type { NativeChatForkWindowSource } from './native-chat-fork-window-source'
import type { ChatForkSurface } from '../../../../../../../shared/native-chat/chat-fork-path'

// Export and commit run the SDK copy on the host, which may take up to two minutes there.
const HOST_FORK_CALL_TIMEOUT_MS = 180_000

type HostForkInput = {
  source: NativeChatForkWindowSource
  throughItemId: string
  targetHostId: ExecutionHostId
  hostLabel: string
  targetWorktreeId: string
  /** The copy resumes in a terminal (Claude's CLI) or as a chat, whatever kind the source was. */
  openAs: ChatForkSurface
  draft?: string
  /** The copy's name: its tab, its chat's own name, and Claude's session name. */
  name?: string
  signal?: AbortSignal
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function relayCall(target: RuntimeClientTarget, signal?: AbortSignal) {
  return (method: string, params: Record<string, unknown>): Promise<unknown> =>
    callRuntimeRpc<unknown>(target, method, params, {
      timeoutMs: HOST_FORK_CALL_TIMEOUT_MS,
      ...(signal ? { signal } : {})
    })
}

function relayFailureText(error: unknown): string | undefined {
  switch (chatForkTransferErrorCode(error)) {
    case 'chat_fork_transfer_too_large':
      return translate(
        'components.native-chat.fork.host.tooLarge',
        'This chat is too large to copy to another host (limit {{limit}}).',
        { limit: megabytes(CHAT_FORK_TRANSFER_MAX_BYTES) }
      )
    case 'chat_fork_transfer_busy':
      return translate(
        'components.native-chat.fork.host.busy',
        'Other chats are being copied right now. Try again when they finish.'
      )
    case 'chat_fork_import_target_unsupported':
      return translate(
        'components.native-chat.fork.host.targetUnsupported',
        'That workspace can’t take a copied chat (SSH and WSL workspaces aren’t supported yet).'
      )
    case 'chat_fork_source_unavailable':
      return translate(
        'components.native-chat.fork.host.sourceUnavailable',
        'The host couldn’t find this chat’s saved history up to that point.'
      )
    case null:
      return error instanceof Error ? error.message : undefined
    case 'chat_fork_transfer_not_found':
    case 'chat_fork_transfer_offset_mismatch':
    case 'chat_fork_transfer_integrity_failed':
      return translate(
        'components.native-chat.fork.host.transferFailed',
        'The copy didn’t arrive intact. Fork again.'
      )
  }
}

/** Opens the placed copy where it landed: as a chat resuming it, or in a terminal resuming it in Claude. */
async function launchPlacedCopy(
  input: HostForkInput,
  placed: AiVaultCommitChatForkImportResult
): Promise<void> {
  if (input.openAs === 'terminal') {
    await resumeClaudeCopyInNewTerminalTab({
      worktreeId: input.targetWorktreeId,
      sessionId: placed.sessionId,
      filePath: placed.filePath,
      cwd: placed.cwd,
      executionHostId: input.targetHostId,
      ...(input.draft ? { draft: input.draft } : {}),
      ...(input.name ? { name: input.name } : {})
    })
    return
  }
  activateAndRevealWorktree(input.targetWorktreeId, { sidebarRevealBehavior: 'auto' })
  const launch = startStructuredAgentLaunch(input.targetWorktreeId, input.source.agent, {
    requestId: createNonSecureContextUuid(),
    executionHostId: input.targetHostId,
    resumeFrom: { providerSessionId: placed.sessionId },
    surfaceAddress: captureStructuredLaunchSurfaceAddress(input.targetWorktreeId),
    ...(input.draft ? { prompt: input.draft, promptDelivery: 'draft' as const } : {})
  })
  await launch.launchResult
  if (input.name) {
    void nameForkedStructuredChat(launch.executionHostId, launch.sessionId, input.name)
  }
}

/** Copies the chat's exact history through the fork point to a workspace on any host (this one too,
 *  to open it as the other kind), through this client, then opens it there. False when nothing was placed, so the window stays to retry. */
export async function runNativeChatHostFork(input: HostForkInput): Promise<boolean> {
  const targetTarget = ipcOrRuntimeTargetForHostId(input.targetHostId)
  const worktree = useAppStore
    .getState()
    .getKnownWorktreeById(input.targetWorktreeId, input.targetHostId)
  const failedTitle = translate(
    'components.native-chat.fork.host.failed',
    'Couldn’t fork this chat to {{host}}',
    { host: input.hostLabel }
  )
  if (!targetTarget || !worktree) {
    toast.error(failedTitle, {
      description: translate(
        'components.native-chat.fork.host.noWorkspace',
        'That workspace isn’t available on {{host}}. Choose another.',
        { host: input.hostLabel }
      )
    })
    return false
  }
  const copying = (done: number, total: number): string =>
    translate(
      'components.native-chat.fork.host.copying',
      'Copying chat to {{host}}… {{percent}}%',
      {
        host: input.hostLabel,
        percent: total > 0 ? Math.floor((done / total) * 100) : 0
      }
    )
  const toastId = toast.loading(copying(0, 0))
  const { source } = input
  let placed: AiVaultCommitChatForkImportResult
  try {
    const relayed = await relayChatForkTranscript({
      source:
        source.kind === 'terminal'
          ? {
              terminal: {
                sessionId: source.sessionId,
                throughEntryId: source.cutThrough(input.throughItemId)
              }
            }
          : {
              structured: {
                sessionId: source.sessionId,
                workspaceId: source.worktreeId,
                throughItemId: input.throughItemId
              }
            },
      targetWorktree: toRuntimeWorktreeSelector(input.targetWorktreeId),
      sourceCall: relayCall(source.target, input.signal),
      targetCall: relayCall(targetTarget, input.signal),
      ...(input.name ? { title: input.name } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      onProgress: (done, total) => toast.loading(copying(done, total), { id: toastId })
    })
    placed = relayed.placed
  } catch (error) {
    // Leaving the chat mid-copy cancels it on purpose; that is not a failure to report.
    if (input.signal?.aborted) {
      toast.dismiss(toastId)
      return false
    }
    toast.error(failedTitle, { id: toastId, description: relayFailureText(error) })
    return false
  }
  try {
    await launchPlacedCopy(input, placed)
    toast.success(
      translate(
        'components.native-chat.fork.host.started',
        'Forked into {{workspace}} on {{host}}',
        {
          workspace: worktree.displayName,
          host: input.hostLabel
        }
      ),
      { id: toastId }
    )
  } catch (error) {
    // The copy is on the host now; Session History there can still open it.
    toast.error(failedTitle, {
      id: toastId,
      description: translate(
        'components.native-chat.fork.host.launchFailed',
        'The chat was copied, but it didn’t open: {{reason}}. Open it from Session History on {{host}}.',
        { host: input.hostLabel, reason: error instanceof Error ? error.message : String(error) }
      )
    })
  }
  return true
}

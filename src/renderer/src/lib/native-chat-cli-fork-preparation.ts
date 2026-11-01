import { createBrowserUuid } from './browser-uuid'
import type { AiVaultAgent, AiVaultListResult } from '../../../shared/ai-vault-types'
import { isAiVaultSessionResumableContent } from '../../../shared/ai-vault-types'
import {
  AI_VAULT_CHAT_FORK_SOURCE_CAPABILITY,
  type AiVaultPrepareSessionResumeRequest,
  type AiVaultPrepareSessionResumeResult
} from '../../../shared/ai-vault-resume-preparation'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { prepareAiVaultSessionForFork } from './ai-vault-session-resume-preparation'
import { aiVaultSessionListArgs } from '@/components/right-sidebar/ai-vault-session-list-request'
import {
  findTabSessionHistoryRow,
  type TabSessionHistorySubject
} from '@/components/tab-bar/tab-session-history-switch'
import type { AiVaultResumeCommandSession } from './ai-vault-resume-command'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'

export type NativeChatCliForkSubject = Extract<TabSessionHistorySubject, { kind: 'chat' }>
export type NativeChatCliForkPreparation = {
  session: AiVaultResumeCommandSession
  copied: boolean
  sourceAgent?: AiVaultAgent
}

export async function prepareNativeChatCliFork(
  subject: NativeChatCliForkSubject,
  options: { pairingRevision?: number; isCurrent: () => boolean; signal: AbortSignal }
): Promise<NativeChatCliForkPreparation> {
  const hostId = subject.request.executionHostScope
  const host = parseExecutionHostId(hostId)
  if (!host || (host.kind !== 'local' && host.kind !== 'runtime')) {
    throw new Error('The conversation host is unavailable.')
  }
  const target =
    host.kind === 'runtime'
      ? { kind: 'environment' as const, environmentId: host.environmentId }
      : { kind: 'local' as const }
  const observe = async <T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>) => {
    const deadline = new AbortController()
    const timer = setTimeout(
      () => deadline.abort(new Error('Conversation preparation timed out.')),
      timeoutMs
    )
    const signal = AbortSignal.any([options.signal, deadline.signal])
    try {
      signal.throwIfAborted()
      if (!options.isCurrent()) {
        throw new Error('The source chat changed before preparation.')
      }
      return await waitForPromiseWithSignal(run(signal), signal)
    } finally {
      clearTimeout(timer)
    }
  }
  const callOptions = (timeoutMs: number, signal: AbortSignal) => ({
    timeoutMs,
    signal,
    expectedEnvironmentPairingRevision: options.pairingRevision
  })
  const request = (args: AiVaultPrepareSessionResumeRequest) =>
    observe(90_000, (signal) =>
      host.kind === 'local'
        ? window.api.aiVault.prepareSessionResume(args)
        : callRuntimeRpc<AiVaultPrepareSessionResumeResult>(
            target,
            'aiVault.prepareSessionResume',
            args,
            callOptions(90_000, signal)
          )
    )
  // Local desktop and host ship together; only a paired peer needs negotiation.
  const modern =
    host.kind === 'local' ||
    (
      await observe(30_000, (signal) =>
        callRuntimeRpc<RuntimeStatus>(target, 'status.get', undefined, callOptions(30_000, signal))
      )
    ).capabilities?.includes(AI_VAULT_CHAT_FORK_SOURCE_CAPABILITY) === true
  if (!options.isCurrent()) {
    throw new Error('The source chat changed before preparation.')
  }
  if (modern) {
    return prepareAiVaultSessionForFork(
      {
        sourceChat: { sessionId: subject.sessionId, workspaceId: subject.workspaceId },
        executionHostId: host.id,
        fork: true
      },
      request
    )
  }
  // Old peers alone need one same-host inventory; never force a rescan or retry a modern error.
  const listed = await observe(150_000, (signal) =>
    callRuntimeRpc<AiVaultListResult>(
      target,
      'aiVault.listSessions',
      {
        ...aiVaultSessionListArgs(subject.request, { requestToken: createBrowserUuid() }),
        executionHostId: host.id
      },
      callOptions(150_000, signal)
    )
  )
  if (!options.isCurrent()) {
    throw new Error('The source chat changed before preparation.')
  }
  const row = findTabSessionHistoryRow(listed.sessions, subject)
  if (!row || row.executionHostId !== host.id || !isAiVaultSessionResumableContent(row)) {
    throw new Error('This chat has no saved conversation to copy.')
  }
  return { ...(await prepareAiVaultSessionForFork(row, request)), sourceAgent: row.agent }
}

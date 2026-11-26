import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'

import {
  AI_VAULT_SINGLE_HOST_LIST_TIMEOUT_MS,
  type AiVaultListResult,
  isAiVaultSessionResumableContent
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  AI_VAULT_CHAT_FORK_SOURCE_CAPABILITY,
  type AiVaultPrepareSessionResumeRequest,
  type AiVaultPrepareSessionResumeResult
} from '../../../../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import type { RuntimeStatus } from '../../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { parseExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { prepareAiVaultSessionForFork } from '../history/ai-vault-session-resume-preparation'
import { conversationHostUnavailableError } from '../history/ai-vault-session-fork-startup'
import { aiVaultSessionListArgs } from '@/components/right-sidebar/ai-vault/scanning/ai-vault-session-list-request'
import {
  findTabSessionHistoryRow,
  type TabSessionHistorySubject
} from '@/components/tab-bar/session-actions/tab-session-history-switch'
import type { AiVaultResumeCommandSession } from '../../../../../../shared/ai-vault/resume/ai-vault-resume-startup'
import { waitForPromiseWithSignal } from '../../../../../../shared/concurrency/abort-signal-reason'
import { translate } from '@/i18n/i18n'

export type NativeChatCliForkSubject = Extract<TabSessionHistorySubject, { kind: 'chat' }>
export type NativeChatCliForkPreparation = {
  session: AiVaultResumeCommandSession
  copied: boolean
}

function sourceChatChangedError(): Error {
  return new Error(
    translate(
      'auto.lib.nativeChatCliFork.sourceChanged',
      'The source chat changed before preparation.'
    )
  )
}

export async function prepareNativeChatCliFork(
  subject: NativeChatCliForkSubject,
  options: { pairingRevision?: number; isCurrent: () => boolean; signal: AbortSignal }
): Promise<NativeChatCliForkPreparation> {
  const hostId = subject.request.executionHostScope
  const host = parseExecutionHostId(hostId)
  if (!host || (host.kind !== 'local' && host.kind !== 'runtime')) {
    throw conversationHostUnavailableError()
  }
  const target =
    host.kind === 'runtime'
      ? { kind: 'environment' as const, environmentId: host.environmentId }
      : { kind: 'local' as const }
  const observe = async <T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>) => {
    const deadline = new AbortController()
    const timer = setTimeout(
      () =>
        deadline.abort(
          new Error(
            translate(
              'auto.lib.nativeChatCliFork.preparationTimedOut',
              'Conversation preparation timed out.'
            )
          )
        ),
      timeoutMs
    )
    const signal = AbortSignal.any([options.signal, deadline.signal])
    try {
      signal.throwIfAborted()
      if (!options.isCurrent()) {
        throw sourceChatChangedError()
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
    throw sourceChatChangedError()
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
  const listed = await observe(AI_VAULT_SINGLE_HOST_LIST_TIMEOUT_MS, (signal) =>
    callRuntimeRpc<AiVaultListResult>(
      target,
      'aiVault.listSessions',
      {
        ...aiVaultSessionListArgs(subject.request, { requestToken: createBrowserUuid() }),
        executionHostId: host.id
      },
      callOptions(AI_VAULT_SINGLE_HOST_LIST_TIMEOUT_MS, signal)
    )
  )
  if (!options.isCurrent()) {
    throw sourceChatChangedError()
  }
  const row = findTabSessionHistoryRow(listed.sessions, subject)
  if (!row || row.executionHostId !== host.id || !isAiVaultSessionResumableContent(row)) {
    throw new Error(
      translate(
        'auto.lib.nativeChatCliFork.noSavedConversation',
        'This chat has no saved conversation to copy.'
      )
    )
  }
  return prepareAiVaultSessionForFork(row, request)
}

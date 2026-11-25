import {
  activateAiVaultStructuredSession,
  structuredSessionOpenFeedback
} from './agent-session/open/activate-ai-vault-structured-session'
import { openOrchestrationDispatch } from './agent-session/open/open-agent-message-sender'
import {
  showLookupFailure,
  type LookupFailure
} from './agent-session/open/open-located-agent-message-sender'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { showAgentPaneUnavailable } from '@/components/terminal-pane/agent-status/stale-agent-row'
import { openAiVaultSessionLogInOrca } from '@/components/right-sidebar/ai-vault/session-actions/ai-vault-session-log-open'
import { canOpenAiVaultSessionLogInOrca } from '@/components/right-sidebar/ai-vault/session-actions/ai-vault-session-path-actions'
import {
  isAiVaultAgent,
  type AiVaultSession
} from '../../../shared/ai-vault/contracts/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import {
  ORCHESTRATION_WORKER_TRANSCRIPT_METHOD,
  type OrchestrationWorkerTranscriptResult
} from '../../../shared/orchestration/workers/orchestration-worker-transcript'
import { revealTerminalPane } from './workspace/activation/reveal-terminal-pane'
import {
  activateAndRevealWorkspaceWithOutcome,
  activateAndRevealWorktree
} from './workspace/activation/worktree-activation'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import type { RuntimeClientTarget } from '../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { OrchestrationSessionWorker } from '../../../shared/orchestration-session-workers'

/** Opens a worker's workspace on its own pane; `hostId` names a paired computer's workspace. */
export function revealWorkerPane(
  workspaceId: string,
  paneKey: string | null,
  hostId?: `runtime:${string}`
): void {
  const pane = paneKey ? parsePaneKey(paneKey) : null
  if (pane) {
    revealTerminalPane({
      worktreeId: workspaceId,
      tabId: pane.tabId,
      leafId: pane.leafId,
      executionHostId: hostId ?? null
    })
  } else {
    activateAndRevealWorktree(workspaceId, hostId ? { executionHostId: hostId } : undefined)
  }
}

type OpenableWorker = Pick<
  OrchestrationSessionWorker,
  'dispatchId' | 'title' | 'worktreeId' | 'chatSessionId'
> &
  Partial<Pick<OrchestrationSessionWorker, 'host'>>

/** A worker whose terminal is gone and has no log to show opens its workspace, where its work is. Only a workspace its
 *  record places on the host that answered: a federated worker's is on another computer, and a row without a record
 *  gets the notice. */
function revealWorkspaceOfGoneTerminal(worker: OpenableWorker, target: RuntimeClientTarget): void {
  const outcome =
    worker.host === 'local' && worker.worktreeId
      ? activateAndRevealWorkspaceWithOutcome(worker.worktreeId, {
          // Named even for this computer, so a paired copy with the same id never stands in for it.
          executionHostId:
            target.kind === 'environment'
              ? `runtime:${target.environmentId}`
              : LOCAL_EXECUTION_HOST_ID
        })
      : null
  if (outcome && 'opened' in outcome) {
    return
  }
  // Activation that refused has said why itself.
  if (!outcome?.refused.failureNotified) {
    showAgentPaneUnavailable()
  }
}

/** Opens the worker's chat tab, else the worker through its Dispatch, so a terminal Orca closed reopens;
 *  a terminal that is gone for good (its workspace removed, say) shows the conversation's log instead,
 *  and with no log to show, the worker's workspace. */
export function openOrchestrationWorker(worker: OpenableWorker, target: RuntimeClientTarget): void {
  if (worker.chatSessionId && worker.worktreeId) {
    void activateAiVaultStructuredSession(
      { structuredSession: { workspaceId: worker.worktreeId, sessionId: worker.chatSessionId } },
      undefined,
      target
    )
    return
  }
  // The host finds the terminal gone at lookup (no pane for its handle), or focus finds it gone.
  const terminalGone = (): void =>
    void openWorkerTranscript(worker.dispatchId, target, () =>
      revealWorkspaceOfGoneTerminal(worker, target)
    )
  void openOrchestrationDispatch(`dispatch:${worker.dispatchId}`, worker.title, target, {
    open: { ...structuredSessionOpenFeedback, terminalGone },
    terminal: {
      gone: terminalGone,
      lookupFailure: (failure: LookupFailure) => showLookupFailure(failure, worker.title)
    }
  })
}

/** The worker's conversation log, read only; `noLog` when there is none to show (the dead-pane notice by default). */
export async function openWorkerTranscript(
  dispatchId: string,
  target: RuntimeClientTarget,
  noLog: () => void = showAgentPaneUnavailable
): Promise<void> {
  // The host answers with its own paths, which only this computer's host shares with us.
  if (target.kind === 'local') {
    let result: OrchestrationWorkerTranscriptResult | null = null
    try {
      result = await callRuntimeRpc<OrchestrationWorkerTranscriptResult>(
        target,
        ORCHESTRATION_WORKER_TRANSCRIPT_METHOD,
        { dispatch: dispatchId }
      )
    } catch {
      // An older host has no transcript method; it falls through to noLog.
    }
    const transcript = result?.transcript
    const log: Pick<AiVaultSession, 'agent' | 'filePath' | 'executionHostId'> | null =
      transcript && isAiVaultAgent(transcript.agent)
        ? {
            agent: transcript.agent,
            filePath: transcript.path,
            executionHostId: LOCAL_EXECUTION_HOST_ID
          }
        : null
    if (log && canOpenAiVaultSessionLogInOrca(log)) {
      if (await openAiVaultSessionLogInOrca(log, { notifyMissingWorkspace: false })) {
        return
      }
    }
  }
  noLog()
}

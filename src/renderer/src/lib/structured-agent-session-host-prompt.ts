import type {
  AgentLaunchPromptDisposal,
  AgentLaunchResult
} from '../../../shared/agent-launch-intent'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { StagedStructuredLaunchPrompt } from './structured-agent-session-launch-prompt'
import { handBackStructuredAgentSessionMessage } from '@/components/native-chat/structured-agent-session-message-hand-back'
import { publishStructuredAgentSessionSends } from '@/components/native-chat/structured-agent-session-pending-sends'
import { agentSessionWriteNoticeText } from '@/components/native-chat/agent-session-write-notice-text'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import {
  getRuntimeEnvironmentRevision,
  resolveContinuedRuntimeEnvironmentRevision,
  isRuntimeEnvironmentContinuationPending
} from '@/runtime/runtime-environment-revision'

export type HostCreatedPrompt = {
  executionHostId: ExecutionHostId
  target: RuntimeClientTarget
  pairingRevision?: number
  pane: { tabId: string; leafId: string }
  agent: TuiAgent
  delivery: 'submit' | 'draft'
  presentDraft: (actual: NonNullable<HostCreatedPrompt['actual']>, text: string) => void
  messageId: string
  actual?:
    | { kind: 'structured'; worktreeId?: string }
    | {
        kind: 'terminal'
        ptyId: string
        worktreeId: string
        tabId: string
      }
  disposal?: AgentLaunchPromptDisposal
  dismissed?: true
  take: () => boolean
  terminalNotice: (
    tabId: string,
    leafId: string,
    text: string,
    outcome: 'not-delivered' | 'unconfirmed'
  ) => void
}

export function hostPromptOwnerCurrent(host: HostCreatedPrompt): boolean {
  if (host.target.kind === 'local') {
    return true
  }
  const id = host.target.environmentId
  const current = getRuntimeEnvironmentRevision(id)
  return (
    host.pairingRevision !== undefined &&
    current !== undefined &&
    !isRuntimeEnvironmentContinuationPending(id, host.pairingRevision) &&
    resolveContinuedRuntimeEnvironmentRevision(id, host.pairingRevision) === current
  )
}

/** The claim leaves before any draft/notice listener can reenter; saved request text cannot revive it. */
export function finishHostCreatedPrompt(
  prompt: StagedStructuredLaunchPrompt,
  outcome: 'recorded' | 'returned' | 'unconfirmed' | 'dropped'
): void {
  const host = prompt.hostCreate
  if (!host || !host.take()) {
    return
  }
  try {
    if (outcome === 'recorded') {
      prompt.createSend?.settle({
        kind: 'recorded-proof',
        sessionId: prompt.sessionId,
        clientMessageId: host.messageId
      })
    } else {
      prompt.createSend?.drop()
    }
  } catch (error) {
    console.error('[native-chat-send] opening input settlement failed', error)
  }
  if (
    (outcome !== 'returned' && outcome !== 'unconfirmed') ||
    !host.actual ||
    !hostPromptOwnerCurrent(host)
  ) {
    return
  }
  try {
    if (host.actual.kind === 'terminal') {
      host.terminalNotice(
        host.actual.tabId,
        host.pane.leafId,
        prompt.text,
        outcome === 'returned' ? 'not-delivered' : 'unconfirmed'
      )
    } else if (prompt.createSend) {
      handBackStructuredAgentSessionMessage(
        prompt.sessionId,
        host.messageId,
        prompt.createSend.message.body
      )
      publishStructuredAgentSessionSends(prompt.sessionId, {
        notice: agentSessionWriteNoticeText(
          outcome === 'unconfirmed' ? ['sendOutcomeLost'] : ['notDoneSend', 'tryAgainComposerSend']
        )
      })
    }
  } catch (error) {
    console.error('[native-chat-send] opening input presentation failed', error)
  }
}

export function settleHostCreatedPromptAtTarget(prompt: StagedStructuredLaunchPrompt): void {
  const host = prompt.hostCreate
  if (!host?.actual || !hostPromptOwnerCurrent(host)) {
    return
  }
  if (host.delivery === 'draft') {
    if (host.take()) {
      try {
        host.presentDraft(host.actual, prompt.text)
      } catch (error) {
        console.error('[native-chat-send] opening draft presentation failed', error)
      }
    }
    return
  }
  if (host.disposal?.outcome === 'journaled' && host.disposal.messageId === host.messageId) {
    finishHostCreatedPrompt(prompt, 'recorded')
  } else if (host.actual.kind === 'terminal' && host.disposal?.outcome === 'handed-to-terminal') {
    finishHostCreatedPrompt(prompt, 'recorded')
  } else if (host.disposal?.outcome === 'not-delivered') {
    finishHostCreatedPrompt(prompt, 'returned')
  } else if (host.dismissed || host.disposal) {
    finishHostCreatedPrompt(prompt, 'unconfirmed')
  } else if (host.actual.kind === 'structured') {
    prompt.createSend?.activate()
  }
}

export function noteHostCreatedPromptResult(
  prompt: StagedStructuredLaunchPrompt,
  launch: AgentLaunchResult
): void {
  const host = prompt.hostCreate
  if (!host || !hostPromptOwnerCurrent(host)) {
    return
  }
  if (launch.outcome.kind === 'structured') {
    if (launch.outcome.sessionId !== prompt.sessionId) {
      return
    }
    host.actual = { kind: 'structured', worktreeId: launch.worktreeId }
  } else {
    if (launch.outcome.paneKey !== `${host.pane.tabId}:${host.pane.leafId}`) {
      return
    }
    host.actual = {
      kind: 'terminal',
      ptyId:
        host.target.kind === 'local'
          ? launch.outcome.handle
          : toRemoteRuntimePtyId(launch.outcome.handle, host.target.environmentId),
      worktreeId: launch.worktreeId,
      tabId:
        host.target.kind === 'local' ? host.pane.tabId : toWebTerminalSurfaceTabId(host.pane.tabId)
    }
  }
  host.disposal = launch.prompt?.delivery === 'submit' ? launch.prompt : { outcome: 'unconfirmed' }
  settleHostCreatedPromptAtTarget(prompt)
}

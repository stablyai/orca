import type { AppState } from '@/store/types'
import { retireDesktopCreatePresentation } from './structured-agent-session-desktop-create-cancellation'
import { acceptDesktopCreateTopology } from './structured-agent-session-desktop-create-presentation'
import type { AgentLaunchResult } from '../../../shared/agent-launch-intent'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { deriveAgentLaunchChildOperationId } from '../../../shared/agent-launch-child-operation'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { toHostSessionTabId, toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import {
  stagedStructuredLaunchPrompts as staged,
  unstageStructuredLaunchPrompt as unstage,
  stageStructuredLaunchPrompt,
  type StagedStructuredLaunchPrompt
} from './structured-agent-session-launch-prompt'
import {
  finishHostCreatedPrompt,
  hostPromptOwnerCurrent,
  noteHostCreatedPromptResult,
  settleHostCreatedPromptAtTarget,
  type HostCreatedPrompt
} from './structured-agent-session-host-prompt'

export function hostPanePromptKey(host: string, tabId: string, leafId: string): string {
  return JSON.stringify(['host-pane', host, tabId, leafId])
}

export function hostPromptIndexKey(hostId: ExecutionHostId): string {
  return JSON.stringify(['host-prompts', hostId])
}

export function hostTabPromptKey(host: string, tabId: string): string {
  return JSON.stringify(['host-tab', host, tabId])
}

/** Exact host aliases share the existing staged owner, never a second delivery request. */
export function stageHostCreatedLaunchPrompt(args: {
  sessionId: string
  operationId: string
  paneKey: string
  text: string
  executionHostId: ExecutionHostId
  target: RuntimeClientTarget
  agent: HostCreatedPrompt['agent']
  terminalNotice: HostCreatedPrompt['terminalNotice']
  delivery: HostCreatedPrompt['delivery']
  presentDraft: HostCreatedPrompt['presentDraft']
}): StagedStructuredLaunchPrompt | null {
  const child = deriveAgentLaunchChildOperationId(args.operationId)
  const messageId = child && deriveAgentLaunchChildOperationId(child)
  const pane = parsePaneKey(args.paneKey)
  if (!messageId || !pane) {
    throw new Error('Invalid opening input identity')
  }
  const prompt = stageStructuredLaunchPrompt(args.sessionId, args.text, {
    callerKeepsText: true,
    clientMessageId: messageId,
    ...(args.delivery === 'draft' ? { reserve: false as const } : {})
  })
  if (!prompt.slot && args.delivery !== 'draft') {
    unstage(prompt)
    return null
  }
  const take = (): boolean => {
    if (!staged.get(prompt.sessionId)?.has(prompt)) {
      return false
    }
    unstage(prompt)
    return true
  }
  prompt.hostCreate = {
    ...args,
    pane,
    messageId,
    take,
    pairingRevision:
      args.target.kind === 'environment'
        ? getRuntimeEnvironmentRevision(args.target.environmentId)
        : undefined
  }
  const hostKey = hostPromptIndexKey(args.executionHostId)
  let forHost = staged.get(hostKey)
  if (!forHost) {
    forHost = new Set()
    staged.set(hostKey, forHost)
  }
  forHost.add(prompt)
  const aliases = new Set([prompt])
  staged.set(hostPanePromptKey(args.executionHostId, pane.tabId, pane.leafId), aliases)
  staged.set(hostTabPromptKey(args.executionHostId, pane.tabId), aliases)
  prompt.createOwned = true
  prompt.createSend =
    prompt.slot?.create(args.target, {
      deferUntilTarget: true,
      beforeFinish: (outcome) => finishHostCreatedPrompt(prompt, outcome)
    }) ?? undefined
  return prompt
}

export function settleHostCreatedLaunchResult(
  sessionId: string,
  hostId: ExecutionHostId,
  launch: AgentLaunchResult
): void {
  for (const prompt of staged.get(sessionId) ?? []) {
    if (prompt.hostCreate?.executionHostId === hostId) {
      noteHostCreatedPromptResult(prompt, launch)
    }
  }
}

/** Loaded history and a real fence prove this exact session even if its publication was missed. */
export function noteHostCreatedLaunchRead(sessionId: string, hostId: ExecutionHostId): void {
  for (const prompt of staged.get(sessionId) ?? []) {
    if (prompt.hostCreate?.executionHostId !== hostId) {
      continue
    }
    prompt.hostCreate.actual = { kind: 'structured' }
    settleHostCreatedPromptAtTarget(prompt)
  }
}

/** Unknown/dismissed progress retains one return claim until an actual target is known. */
export function markHostCreatedLaunchUnconfirmed(sessionId: string): void {
  for (const prompt of staged.get(sessionId) ?? []) {
    if (!prompt.hostCreate) {
      continue
    }
    prompt.hostCreate.disposal = { outcome: 'unconfirmed' }
    settleHostCreatedPromptAtTarget(prompt)
  }
}

export function dismissHostCreatedLaunchPrompt(sessionId: string): void {
  for (const prompt of staged.get(sessionId) ?? []) {
    if (!prompt.hostCreate) {
      continue
    }
    prompt.hostCreate.dismissed = true
    settleHostCreatedPromptAtTarget(prompt)
  }
}

export function recordHostCreatedLaunchMessage(sessionId: string, messageId: string): void {
  for (const prompt of staged.get(sessionId) ?? []) {
    if (prompt.hostCreate?.messageId === messageId) {
      finishHostCreatedPrompt(prompt, 'recorded')
    }
  }
}

export function abandonHostCreatedLaunchPrompts(sessionId: string, hostId: ExecutionHostId): void {
  for (const prompt of staged.get(sessionId) ?? []) {
    if (prompt.hostCreate?.executionHostId === hostId) {
      finishHostCreatedPrompt(prompt, 'dropped')
    }
  }
}

/** Only an explicit close, not a missing row, revokes the exact terminal alias. */
export function abandonHostCreatedLaunchPane(
  hostId: ExecutionHostId,
  localTabId: string,
  leafId: string
): void {
  retireDesktopCreatePresentation(
    `desktop-pane:${hostId}:${toHostSessionTabId(localTabId)}:${leafId}`
  )
  const key = hostPanePromptKey(hostId, toHostSessionTabId(localTabId), leafId)
  for (const prompt of staged.get(key) ?? []) {
    finishHostCreatedPrompt(prompt, 'dropped')
  }
}

export function abandonHostCreatedLaunchTab(hostId: ExecutionHostId, localTabId: string): void {
  retireDesktopCreatePresentation(`desktop-tab:${hostId}:${toHostSessionTabId(localTabId)}`)
  for (const prompt of staged.get(hostTabPromptKey(hostId, toHostSessionTabId(localTabId))) ?? []) {
    finishHostCreatedPrompt(prompt, 'dropped')
  }
}

/** Called only after the ordinary host/generation/version/cancellation acceptance boundary. */
export function noteHostCreatedLaunchTargets(
  hostId: ExecutionHostId,
  snapshot: RuntimeMobileSessionTabsResult,
  get: () => AppState
): void {
  acceptDesktopCreateTopology(hostId, snapshot, get)
  if (!staged.has(hostPromptIndexKey(hostId))) {
    return
  }
  for (const tab of snapshot.tabs) {
    const key =
      tab.type === 'agent-session'
        ? tab.sessionId
        : tab.type === 'terminal'
          ? hostPanePromptKey(hostId, tab.parentTabId, tab.leafId)
          : null
    for (const prompt of (key && staged.get(key)) || []) {
      const host = prompt.hostCreate
      if (!host || host.executionHostId !== hostId || !hostPromptOwnerCurrent(host)) {
        continue
      }
      if (tab.type === 'agent-session' && tab.agent === host.agent) {
        host.actual = { kind: 'structured', worktreeId: snapshot.worktree }
      } else if (
        tab.type === 'terminal' &&
        tab.status === 'ready' &&
        tab.terminal &&
        tab.launchAgent === host.agent
      ) {
        host.actual = {
          kind: 'terminal',
          ptyId:
            host.target.kind === 'local'
              ? tab.terminal
              : toRemoteRuntimePtyId(tab.terminal, host.target.environmentId),
          worktreeId: snapshot.worktree,
          tabId:
            host.target.kind === 'local'
              ? tab.parentTabId
              : toWebTerminalSurfaceTabId(tab.parentTabId)
        }
      } else {
        continue
      }
      settleHostCreatedPromptAtTarget(prompt)
    }
  }
}

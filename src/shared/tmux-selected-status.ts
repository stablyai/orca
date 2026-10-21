import { createHash } from 'node:crypto'
import type { TmuxHookPane } from './tmux-client-attachment'
import { normalizeAgentStatusPayload, type AgentStatusIpcPayload } from './agent-status-types'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import type { AgentStatusStore } from './agent-status-store'
import type { AgentHookUnavailableEnvelope } from './agent-hook-relay'
import {
  serializeAgentStatusSubject,
  type AgentStatusExecutionScope,
  type AgentStatusPtySubject
} from './agent-status-subject'

/** Commit the attachment projection in its owner's store, retaining the inner observation clock. */
export function commitTmuxSelectedStatus(
  store: AgentStatusStore,
  subject: AgentStatusPtySubject,
  event: AgentHookEventPayload,
  observedAt: number,
  stateStartedAt = observedAt,
  now = Date.now()
) {
  const previous = store.getParent(subject)
  const status = {
    ...event.payload,
    paneKey: subject.paneKey,
    tabId: event.tabId,
    worktreeId: subject.workspaceId,
    connectionId: event.connectionId,
    launchToken: event.launchToken,
    providerSession: event.providerSession,
    promptInteractionKey: event.promptInteractionKey,
    receivedAt: Math.max(now, (previous?.status?.receivedAt ?? -1) + 1),
    evidenceObservedAt: observedAt,
    stateStartedAt
  }
  const mutation = store.applyMutation({
    removeFacts: ['tmux.unavailable', 'tmux.source', 'tmux.tabId', 'tmux.launchToken'].map(
      (key) => ({ subject, key })
    ),
    parent: { subject, status, firstObservedAt: previous?.firstObservedAt ?? observedAt }
  })
  return mutation ? store.getParent(subject)?.status : undefined
}

/** Legacy wire projection is derived from the committed record, never a writable row cache. */
export function tmuxCanonicalStatusEvent(status: AgentStatusIpcPayload): AgentHookEventPayload {
  const payload = normalizeAgentStatusPayload(status)
  if (!payload) {
    throw new Error('Invalid committed tmux status')
  }
  return {
    paneKey: status.paneKey,
    tabId: status.tabId,
    worktreeId: status.worktreeId,
    connectionId: status.connectionId,
    source: status.agentType === 'opencode2' ? 'opencode2' : 'opencode',
    launchToken: status.launchToken,
    providerSession: status.providerSession,
    promptInteractionKey: status.promptInteractionKey,
    hasExplicitPrompt: status.prompt.length > 0,
    hostEvidenceObservedAt: status.evidenceObservedAt ?? status.receivedAt,
    hookEventName:
      status.state === 'done'
        ? 'SessionIdle'
        : status.state === 'waiting'
          ? status.toolName
            ? 'PermissionRequest'
            : 'AskUserQuestion'
          : 'SessionBusy',
    payload
  }
}

export function commitTmuxUnavailable(
  store: AgentStatusStore,
  subject: AgentStatusPtySubject,
  identity?: Pick<AgentHookEventPayload, 'source' | 'tabId' | 'launchToken'>
) {
  const previous = store.getParent(subject)
  const status = previous?.status
  const correlation = status
    ? {
        source: status.agentType === 'opencode2' ? 'opencode2' : 'opencode',
        tabId: status.tabId,
        launchToken: status.launchToken
      }
    : identity
  const facts = [{ subject, key: 'tmux.unavailable', value: true }]
  store.applyMutation({
    parent: { subject, firstObservedAt: previous?.firstObservedAt ?? Date.now() },
    facts: [
      ...facts,
      ...(correlation
        ? [
            {
              subject,
              key: 'tmux.source',
              value: correlation.source ?? 'opencode'
            },
            { subject, key: 'tmux.tabId', value: correlation.tabId ?? null },
            { subject, key: 'tmux.launchToken', value: correlation.launchToken ?? null }
          ]
        : [])
    ]
  })
  return readTmuxUnavailable(store, subject)
}

export function readTmuxUnavailable(
  store: AgentStatusStore,
  subject: AgentStatusPtySubject
): AgentHookUnavailableEnvelope | undefined {
  const key = serializeAgentStatusSubject(subject)
  const facts = new Map(
    store
      .getSnapshot()
      .facts.filter((fact) => serializeAgentStatusSubject(fact.subject) === key)
      .map((fact) => [fact.key, fact.value])
  )
  if (facts.get('tmux.unavailable') !== true) {
    return undefined
  }
  const tabId = facts.get('tmux.tabId')
  const launchToken = facts.get('tmux.launchToken')
  return {
    source: facts.get('tmux.source') === 'opencode2' ? 'opencode2' : 'opencode',
    paneKey: subject.paneKey,
    worktreeId: subject.workspaceId,
    ...(typeof tabId === 'string' ? { tabId } : {}),
    ...(typeof launchToken === 'string' ? { launchToken } : {}),
    connectionId: null,
    statusUnavailable: true,
    payload: null
  }
}

export function isTmuxInnerSubject(subject: { kind: string; paneKey?: string }): boolean {
  return subject.kind === 'pty' && subject.paneKey?.startsWith('tmux-inner:') === true
}

export function tmuxInnerSubject(
  scope: AgentStatusExecutionScope,
  outerPaneKey: string,
  tmux: TmuxHookPane
): AgentStatusPtySubject {
  const digest = createHash('sha256')
    .update(`${outerPaneKey}\0${tmux.socket}\0${tmux.pane}`)
    .digest('hex')
  return { ...scope, kind: 'pty', paneKey: `tmux-inner:${digest}` }
}

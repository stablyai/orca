import type { AgentHookSource } from './transport/agent-hook-relay'
import { readAgentEffortLevel } from '../agent-launch/choices/agent-effort-level'
import { readClaudePermissionMode } from '../agent-session/lifecycle/provider-session-live-settings'
import {
  extractAgentProviderSession,
  readPathFromKeys,
  type AgentProviderSessionMetadata
} from '../agent-session/lifecycle/agent-session-resume'
import { readFirstString } from './interactive-tool'
import type { HookListenerState } from './listener-state'
import type { AgentHookEventPayload } from './listener-event'
import { isGrokSubagentEvent } from './providers/grok-tool-fields'
import { isHermesRootSessionEvent, withHermesPaneSessionId } from './providers/hermes-events'
import { readString } from './tool-input-preview'
import { readFirstTranscriptRecord } from './transcript-reader'

export function hasSeparateHookSessionAdmission(
  source: string | undefined
): source is 'hermes' | 'antigravity' {
  return source === 'hermes' || source === 'antigravity'
}

export function readPaneSessionContext(
  state: HookListenerState,
  source: AgentHookSource,
  envelope: { paneKey: string; hookPayloadRecord: Record<string, unknown> },
  eventName: unknown
) {
  const { paneKey, hookPayloadRecord } = envelope
  return {
    providerSession: readPaneProviderSession(state, source, paneKey, hookPayloadRecord, eventName),
    statusAdmissionSession: hasSeparateHookSessionAdmission(source)
      ? extractAgentProviderSession(
          source,
          source === 'hermes'
            ? withHermesPaneSessionId(state, paneKey, hookPayloadRecord)
            : hookPayloadRecord
        )?.id
      : undefined
  }
}

/** The provider session a hook names for its pane; child agents' hooks never name their own. */
function readPaneProviderSession(
  state: HookListenerState,
  source: AgentHookSource,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  eventName: unknown
): AgentProviderSessionMetadata | null {
  if (
    source === 'copilot' &&
    readFirstString(hookPayload, ['agent_id', 'agentId', 'parent_agent_id', 'parentAgentId'])
  ) {
    return null
  }
  if (source === 'codex' && readString(hookPayload, 'agent_id')) {
    return null
  }
  if (source === 'grok' && isGrokSubagentEvent(hookPayload)) {
    // A Grok child's session id is its own; the only child row it emits restates the pane's session.
    const previous = state.lastStatusByPaneKey.get(paneKey)
    return previous?.source === 'grok' ? (previous.providerSession ?? null) : null
  }
  if (
    source === 'hermes' &&
    (!isHermesRootSessionEvent(eventName) ||
      typeof hookPayload.platform !== 'string' ||
      !['cli', 'tui', 'desktop', 'acp'].includes(hookPayload.platform))
  ) {
    return null
  }
  const providerSession = extractAgentProviderSession(source, hookPayload)
  if (!providerSession) {
    return null
  }
  if (source === 'droid') {
    const previous = state.lastStatusByPaneKey.get(paneKey)
    const owner = previous?.payload.agentType === 'droid' ? previous.providerSession : undefined
    if (owner?.id !== providerSession.id && isDroidSubSession(hookPayload)) {
      // Sub-droids inherit the pane, so a worker's hook keeps the orchestrator's session.
      return owner ?? null
    }
  }
  if (source === 'antigravity') {
    const transcriptPath = readPathFromKeys(hookPayload, ['transcriptPath', 'transcript_path'])
    const origin = transcriptPath ? readFirstTranscriptRecord(transcriptPath) : undefined
    if (
      typeof origin !== 'object' ||
      origin === null ||
      !('source' in origin) ||
      origin.source !== 'USER_EXPLICIT' ||
      !('type' in origin) ||
      origin.type !== 'USER_INPUT'
    ) {
      return null
    }
  }
  const continued = continuedProviderSession(
    state,
    source,
    paneKey,
    providerSession.id,
    hookPayload
  )
  const cwd = readAgentCwd(source, hookPayload, continued)
  const effort = readClaudeEffort(source, hookPayload, continued)
  const permissionMode = readClaudeLivePermissionMode(source, hookPayload, continued)
  return {
    ...providerSession,
    ...(cwd ? { cwd } : {}),
    ...(effort ? { effort } : {}),
    ...(permissionMode ? { permissionMode } : {})
  }
}

/** Droid marks a sub-session only in its transcript's first record. */
function isDroidSubSession(hookPayload: Record<string, unknown>): boolean {
  const transcriptPath = readPathFromKeys(hookPayload, ['transcriptPath', 'transcript_path'])
  const origin = transcriptPath ? readFirstTranscriptRecord(transcriptPath) : undefined
  return (
    typeof origin === 'object' &&
    origin !== null &&
    'callingSessionId' in origin &&
    typeof origin.callingSessionId === 'string' &&
    origin.callingSessionId.length > 0
  )
}

/** The pane's previous session when this hook continues it; /clear and compact restart Claude in the same process. */
function continuedProviderSession(
  state: HookListenerState,
  source: AgentHookSource,
  paneKey: string,
  sessionId: string,
  hookPayload: Record<string, unknown>
): AgentProviderSessionMetadata | undefined {
  const previous = state.lastStatusByPaneKey.get(paneKey)
  const continues =
    previous?.providerSession?.id === sessionId ||
    (source === 'claude' &&
      hookPayload.hook_event_name === 'SessionStart' &&
      (hookPayload.source === 'clear' || hookPayload.source === 'compact'))
  // Launch seeds and terminal status rows carry Claude's session without a hook `source`.
  const sameAgent =
    previous?.source === source || (source === 'claude' && previous?.source === undefined)
  return sameAgent && continues ? previous?.providerSession : undefined
}

/** The folder the pane's agent started in. Only Claude/Codex hooks are known to report it (Cursor's cwd is a shell command's). */
function readAgentCwd(
  source: AgentHookSource,
  hookPayload: Record<string, unknown>,
  continued: AgentProviderSessionMetadata | undefined
): string | undefined {
  if (source !== 'claude' && source !== 'codex') {
    return undefined
  }
  const reported = readPathFromKeys(hookPayload, ['cwd'])
  if (source === 'codex') {
    return continued?.cwd ?? reported
  }
  // Only SessionStart names Claude's launch folder; later hooks follow its Bash tool's `cd`.
  if (hookPayload.hook_event_name !== 'SessionStart') {
    return continued?.cwd
  }
  // A new process runs where it reports, even when its launch seed recorded another folder.
  return hookPayload.source === 'startup' || hookPayload.source === 'resume'
    ? (reported ?? continued?.cwd)
    : (continued?.cwd ?? reported)
}

/** Claude 2.1.133+ reports `effort.level` on tool and Stop hooks only, so other events keep the last one. */
function readClaudeEffort(
  source: AgentHookSource,
  hookPayload: Record<string, unknown>,
  continued: AgentProviderSessionMetadata | undefined
): string | undefined {
  if (source !== 'claude') {
    return undefined
  }
  const effort = hookPayload.effort
  // Why skip subagents: their hooks name the parent session but report the subagent's own effort.
  const reported =
    typeof effort === 'object' &&
    effort !== null &&
    'level' in effort &&
    !readString(hookPayload, 'agent_id')
      ? readAgentEffortLevel(effort.level)
      : undefined
  return reported ?? continued?.effort
}

/** Claude names its permission mode on prompt, tool and Stop hooks, not SessionStart, so later events of one process keep the last one. */
function readClaudeLivePermissionMode(
  source: AgentHookSource,
  hookPayload: Record<string, unknown>,
  continued: AgentProviderSessionMetadata | undefined
): string | undefined {
  if (source !== 'claude') {
    return undefined
  }
  // Why skip subagents: their hooks name the parent session but report the subagent's own mode.
  const reported = readString(hookPayload, 'agent_id')
    ? undefined
    : readClaudePermissionMode(hookPayload.permission_mode)
  // A fresh process may run with other flags than the last one on this conversation.
  const freshStart =
    hookPayload.hook_event_name === 'SessionStart' &&
    (hookPayload.source === 'startup' || hookPayload.source === 'resume')
  return reported ?? (freshStart ? undefined : continued?.permissionMode)
}

/** A status correlation may reuse an established owner without publishing a new restore locator. */
function readHookStatusSession(incoming: AgentHookEventPayload): string | undefined {
  return (
    incoming.statusAdmissionSession ??
    incoming.providerSession?.id ??
    (hasSeparateHookSessionAdmission(incoming.agentPresence?.agent) &&
    incoming.agentPresence?.agent === incoming.payload.agentType &&
    !incoming.agentPresence?.ended
      ? incoming.agentPresence?.session
      : undefined)
  )
}

/** Older normalized relays retain some event kinds even after losing the raw ancestry fields. */
export function readHookSessionContext<T extends AgentHookEventPayload>(
  incoming: T,
  fromHook: boolean
) {
  const { statusAdmissionSession: _statusAdmissionSession, ...event } = incoming
  // Relays use scoped session bytes only to compare this hook, never to initialize ownership.
  const ownershipEvent =
    fromHook && event.agentPresence && hasSeparateHookSessionAdmission(event.agentPresence.agent)
      ? { ...event, agentPresence: { ...event.agentPresence, session: undefined } }
      : event
  const rootEvent =
    fromHook &&
    ((event.payload.agentType === 'copilot' && event.toolAgentId) ||
      (event.payload.agentType === 'hermes' &&
        event.hookEventName !== undefined &&
        !isHermesRootSessionEvent(event.hookEventName)))
      ? { ...ownershipEvent, providerSession: undefined }
      : ownershipEvent
  return {
    event: rootEvent,
    statusAdmissionSession:
      fromHook && hasSeparateHookSessionAdmission(incoming.payload.agentType)
        ? readHookStatusSession(incoming)
        : rootEvent.providerSession?.id
  }
}

export function retainHookRootContext(
  incoming: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined,
  fromHook: boolean,
  sameTerminalOwner: boolean,
  returningProviderSession: AgentProviderSessionMetadata | undefined
): AgentHookEventPayload {
  const previousRoot =
    previous &&
    previous.payload.agentType === incoming.payload.agentType &&
    ((incoming.payload.agentType === 'codex' && incoming.toolAgentId) ||
      (fromHook &&
        ['copilot', 'hermes', 'antigravity', 'droid'].includes(incoming.payload.agentType ?? '') &&
        sameTerminalOwner))
      ? previous
      : undefined
  const providerSession =
    !incoming.providerSession && (previousRoot?.providerSession ?? returningProviderSession)
  // Claude reports its model only on SessionStart, so a restart's next hook must keep the saved one.
  const modelSource =
    incoming.payload.agentType === 'codex'
      ? previousRoot
      : incoming.payload.agentType === 'claude' &&
          fromHook &&
          sameTerminalOwner &&
          previous?.payload.agentType === 'claude'
        ? previous
        : undefined
  const model = incoming.payload.model ? undefined : modelSource?.payload.model
  return providerSession || model
    ? {
        ...incoming,
        ...(providerSession ? { providerSession } : {}),
        payload: model ? { ...incoming.payload, model } : incoming.payload
      }
    : incoming
}

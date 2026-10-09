import type { AgentSessionSubscribeEvent } from './agent-session-wire'
import {
  agentChatPermissionModes,
  isAgentChatPermissionMode,
  parseAgentSessionPermissionModes,
  type AgentChatPermissionMode,
  type AgentSessionPermissionFact,
  type AgentSessionPermissionModes
} from './agent-chat-permission-mode'

export type SessionPermissionRequest = {
  identity: string
  fence: number | null
  generation: number
}
export type SessionPermissionPublication = {
  mode: AgentChatPermissionMode | null
  fence: number | null
  revision?: number
}
export type SessionPermissionState = {
  fact: SessionPermissionPublication | null
  supported: readonly AgentChatPermissionMode[] | null | undefined
  generation: number
  confirmedGeneration: number
  pending: { request: SessionPermissionRequest; mode: AgentChatPermissionMode } | null
  seed?: object
  publication?: object
}
export const EMPTY_SESSION_PERMISSION: SessionPermissionState = {
  fact: null,
  supported: undefined,
  generation: 0,
  confirmedGeneration: 0,
  pending: null
}

function conflictingPermissionOrder(
  previous: SessionPermissionPublication,
  fact: SessionPermissionPublication
): boolean {
  if (fact.revision === undefined) {
    return true
  }
  if (fact.revision !== previous.revision) {
    return previous.revision !== undefined && fact.revision < previous.revision
  }
  return fact.mode !== previous.mode
}

function admit(
  state: SessionPermissionState,
  fact: SessionPermissionPublication,
  generation: number,
  supported?: readonly AgentChatPermissionMode[] | null,
  seed = false
): SessionPermissionState {
  const previous = state.fact
  if (previous) {
    if (fact.fence !== previous.fence) {
      if (fact.fence === null || (previous.fence !== null && fact.fence < previous.fence)) {
        return state
      }
    } else if (previous.revision !== undefined || fact.revision !== undefined) {
      if (conflictingPermissionOrder(previous, fact)) {
        return state
      }
    } else if (generation < state.confirmedGeneration || (seed && previous !== state.seed)) {
      return state
    }
  }
  return {
    ...state,
    fact,
    supported:
      supported === undefined
        ? fact.fence !== previous?.fence || (fact.mode !== null && state.supported === null)
          ? undefined
          : state.supported
        : supported,
    generation: Math.max(state.generation, generation),
    confirmedGeneration: Math.max(state.confirmedGeneration, generation)
  }
}

/** A cache read carries the original host order, never a new client observation. */
export function observeSessionPermission(
  state: SessionPermissionState,
  seed?: AgentSessionPermissionFact,
  publication?: SessionPermissionPublication
): SessionPermissionState {
  let next = state
  if (seed !== state.seed) {
    next = seed
      ? admit(next, seed, next.generation + 1, undefined, true)
      : next.fact === state.seed && next.fact?.revision === undefined
        ? { ...next, fact: null, supported: undefined }
        : next
    next = { ...next, seed }
  }
  if (publication !== state.publication) {
    next = publication ? admit(next, publication, next.generation + 1) : next
    next = { ...next, publication }
  }
  return next
}

export function beginSessionPermissionRequest(
  state: SessionPermissionState,
  request: SessionPermissionRequest,
  mode?: AgentChatPermissionMode
): SessionPermissionState {
  return {
    ...state,
    generation: request.generation,
    ...(mode ? { pending: { request, mode } } : {})
  }
}

export function confirmSessionPermissionRead(
  state: SessionPermissionState,
  request: SessionPermissionRequest,
  modes: unknown
): SessionPermissionState {
  const permission = parseAgentSessionPermissionModes(modes)
  const order =
    modes && typeof modes === 'object'
      ? {
          fence: 'fence' in modes && typeof modes.fence === 'number' ? modes.fence : request.fence,
          revision:
            'revision' in modes && typeof modes.revision === 'number' ? modes.revision : undefined
        }
      : { fence: request.fence }
  return admit(
    state,
    { mode: permission?.current ?? null, ...order },
    request.generation,
    permission?.supported ?? null
  )
}

export function resolveSessionPermissionWrite(
  state: SessionPermissionState,
  request: SessionPermissionRequest,
  mode?: string,
  fact?: AgentSessionPermissionFact
): SessionPermissionState {
  const next = fact
    ? admit(state, fact, request.generation)
    : isAgentChatPermissionMode(mode)
      ? admit(state, { mode, fence: request.fence }, request.generation)
      : state
  return next.pending?.request === request ? { ...next, pending: null } : next
}

export function sessionPermissionView(
  state: SessionPermissionState,
  agent: string,
  launchMode?: string
): AgentSessionPermissionModes | null {
  const mode = state.pending?.mode ?? state.fact?.mode ?? (state.fact ? null : launchMode)
  const supported =
    state.supported === undefined ? agentChatPermissionModes(agent) : state.supported
  return isAgentChatPermissionMode(mode) && supported ? { current: mode, supported } : null
}

export function readSessionPermissionPublication(
  event: AgentSessionSubscribeEvent,
  previous: SessionPermissionPublication | undefined,
  fence: number | null
): SessionPermissionPublication | undefined {
  return event.type !== 'end' &&
    (event.permissionMode === null || isAgentChatPermissionMode(event.permissionMode))
    ? {
        mode: event.permissionMode,
        fence,
        revision: event.permissionRevision
      }
    : previous
}

export function sessionPermissionPublicationFields(
  state: {
    permissionMode?: AgentChatPermissionMode | null
    permissionRevision?: number
    permissionPublication?: SessionPermissionPublication
  },
  publication = state.permissionPublication
) {
  return {
    permissionPublication: publication,
    permissionMode: publication ? publication.mode : state.permissionMode,
    permissionRevision: publication ? publication.revision : state.permissionRevision
  }
}

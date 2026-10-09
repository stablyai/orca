import type * as React from 'react'
type PermissionHooks = Pick<
  typeof React,
  'useCallback' | 'useLayoutEffect' | 'useMemo' | 'useRef' | 'useState'
>
import type {
  AgentChatPermissionMode,
  AgentSessionPermissionFact
} from './agent-chat-permission-mode'
import {
  EMPTY_SESSION_PERMISSION,
  beginSessionPermissionRequest,
  confirmSessionPermissionRead,
  observeSessionPermission,
  resolveSessionPermissionWrite,
  sessionPermissionView,
  type SessionPermissionPublication,
  type SessionPermissionRequest,
  type SessionPermissionState
} from './agent-session-permission-reducer'

type Entries = ReadonlyMap<string, SessionPermissionState>
function replace(entries: Entries, identity: string, state: SessionPermissionState): Entries {
  if (entries.get(identity) === state) {
    return entries
  }
  const next = new Map(entries)
  next.delete(identity)
  next.set(identity, state)
  if (next.size > 32) {
    const oldest = next.keys().next().value
    if (oldest !== undefined) {
      next.delete(oldest)
    }
  }
  return next
}

export function useAgentSessionPermissionState(
  args: {
    identity: string
    agent: string
    seed?: AgentSessionPermissionFact
    publication?: SessionPermissionPublication
    fence?: number | null
    launchMode?: string
  },
  hooks: PermissionHooks
) {
  const { useCallback, useLayoutEffect, useMemo, useRef, useState } = hooks
  const { identity, agent, seed, publication, launchMode, fence } = args
  const [stored, setStored] = useState<Entries>(() => new Map())
  const state = observeSessionPermission(
    stored.get(identity) ?? EMPTY_SESSION_PERMISSION,
    seed,
    publication
  )
  const entries = replace(stored, identity, state)
  if (entries !== stored) {
    setStored(entries)
  }
  const entriesRef = useRef(entries)
  useLayoutEffect(() => {
    entriesRef.current = entries
  }, [entries])
  const update = useCallback(
    (key: string, apply: (state: SessionPermissionState) => SessionPermissionState) => {
      const current = entriesRef.current
      const next = replace(current, key, apply(current.get(key) ?? EMPTY_SESSION_PERMISSION))
      entriesRef.current = next
      setStored(next)
    },
    []
  )
  const begin = useCallback(
    (mode?: AgentChatPermissionMode): SessionPermissionRequest => {
      const current = entriesRef.current.get(identity) ?? EMPTY_SESSION_PERMISSION
      const request = {
        identity,
        fence: current.fact?.fence ?? fence ?? null,
        generation: current.generation + 1
      }
      update(identity, (entry) => beginSessionPermissionRequest(entry, request, mode))
      return request
    },
    [identity, fence, update]
  )
  const confirmRead = useCallback(
    (request: SessionPermissionRequest, modes: unknown) => {
      update(request.identity, (entry) => confirmSessionPermissionRead(entry, request, modes))
    },
    [update]
  )
  const confirmWrite = useCallback(
    (request: SessionPermissionRequest, mode?: string, fact?: AgentSessionPermissionFact) => {
      update(request.identity, (entry) => resolveSessionPermissionWrite(entry, request, mode, fact))
    },
    [update]
  )
  const getFence = useCallback(
    () => entriesRef.current.get(identity)?.fact?.fence ?? fence ?? null,
    [identity, fence]
  )
  const permission = useMemo(
    () => sessionPermissionView(state, agent, launchMode),
    [state, agent, launchMode]
  )
  return useMemo(
    () => ({
      permission,
      begin,
      confirmRead,
      confirmWrite,
      getFence,
      pending: state.pending !== null
    }),
    [permission, begin, confirmRead, confirmWrite, getFence, state.pending]
  )
}

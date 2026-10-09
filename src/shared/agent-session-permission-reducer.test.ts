import { expect, it } from 'vitest'
import {
  EMPTY_SESSION_PERMISSION,
  beginSessionPermissionRequest,
  observeSessionPermission,
  confirmSessionPermissionRead,
  resolveSessionPermissionWrite,
  sessionPermissionView
} from './agent-session-permission-reducer'
import { parseAgentSessionPermissionModes } from './agent-chat-permission-mode'
import type { AgentSessionHistoryPage } from './agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from './structured-agent-session-reducer'

it('orders host revisions across every source regardless of local request generations', () => {
  const seed = { mode: 'bypass', fence: 7, revision: 5 } as const
  const cached = { mode: 'auto', fence: 7, revision: 2 } as const
  let state = observeSessionPermission(EMPTY_SESSION_PERMISSION, seed, cached)
  expect(sessionPermissionView(state, 'codex')?.current).toBe('bypass')
  state = confirmSessionPermissionRead(
    state,
    { identity: 'host:chat', fence: 7, generation: 100 },
    {
      current: 'ask',
      supported: ['ask', 'bypass'],
      fence: 7,
      revision: 3
    }
  )
  expect(sessionPermissionView(state, 'codex')?.current).toBe('bypass')
  state = resolveSessionPermissionWrite(
    state,
    { identity: 'host:chat', fence: 7, generation: 1 },
    'ask',
    {
      mode: 'ask',
      fence: 7,
      revision: 6
    }
  )
  expect(sessionPermissionView(state, 'codex')?.current).toBe('ask')
  state = observeSessionPermission(state, seed, { ...cached })
  expect(state.fact).toMatchObject({ mode: 'ask', revision: 6 })
})

it('uses a newer runtime fence even when its revision restarts at zero', () => {
  const cached = { mode: 'auto', fence: 7, revision: 100 } as const
  let state = observeSessionPermission(EMPTY_SESSION_PERMISSION, undefined, cached)
  state = observeSessionPermission(state, { mode: 'ask', fence: 8, revision: 0 }, cached)
  expect(state.fact).toEqual({ mode: 'ask', fence: 8, revision: 0 })
})

it('keeps a pending choice optimistic until its result or refusal resolves it', () => {
  const request = { identity: 'host:chat', fence: 7, generation: 2 }
  let state = observeSessionPermission(EMPTY_SESSION_PERMISSION, {
    mode: 'ask',
    fence: 7,
    revision: 1
  })
  state = beginSessionPermissionRequest(state, request, 'bypass')
  state = observeSessionPermission(state, undefined, { mode: 'auto', fence: 7, revision: 3 })
  expect(sessionPermissionView(state, 'claude')?.current).toBe('bypass')
  state = resolveSessionPermissionWrite(state, request)
  expect(sessionPermissionView(state, 'claude')?.current).toBe('auto')
  expect(state.pending).toBeNull()
})

it('new client against old host retains legacy request ordering and support withdrawal', () => {
  const published = { mode: 'ask', fence: 7 } as const
  let state = observeSessionPermission(EMPTY_SESSION_PERMISSION, undefined, published)
  state = resolveSessionPermissionWrite(
    state,
    { identity: 'chat', fence: 7, generation: 2 },
    'auto'
  )
  state = confirmSessionPermissionRead(
    state,
    { identity: 'chat', fence: 7, generation: 1 },
    {
      current: 'ask',
      supported: ['ask', 'auto', 'bypass']
    }
  )
  expect(sessionPermissionView(state, 'codex')?.current).toBe('auto')
  state = confirmSessionPermissionRead(
    state,
    { identity: 'chat', fence: 7, generation: 3 },
    undefined
  )
  expect(sessionPermissionView(state, 'codex')).toBeNull()
})

it('old client against new host ignores optional permission ordering fields', () => {
  expect(
    parseAgentSessionPermissionModes({
      current: 'auto',
      supported: ['ask', 'auto', 'bypass'],
      fence: 7,
      revision: 9
    })
  ).toEqual({ current: 'auto', supported: ['ask', 'auto', 'bypass'] })
})

it('retained permission keeps its original order when later transcript data changes the fence', () => {
  const page: AgentSessionHistoryPage = {
    sessionId: 'chat',
    epoch: 'epoch',
    direction: 'tail',
    items: [],
    removedItemIds: [],
    submissions: [],
    hasOlder: false,
    hasNewer: false,
    window: { oldest: null, newest: null, nextCursor: { epoch: 'epoch', sequence: 0 } }
  }
  const attached = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
    type: 'event',
    event: {
      type: 'snapshot',
      sessionId: 'chat',
      fence: 7,
      permissionMode: 'auto',
      permissionRevision: 2,
      page
    }
  })
  const cached = reduceStructuredAgentSession(attached, {
    type: 'history-page',
    page: { ...page, fence: 8 }
  })
  expect(cached.fence).toBe(8)
  expect(cached.permissionPublication).toBe(attached.permissionPublication)
  expect(cached.permissionPublication).toEqual({ mode: 'auto', fence: 7, revision: 2 })
  const permission = observeSessionPermission(
    EMPTY_SESSION_PERMISSION,
    { mode: 'ask', fence: 8, revision: 0 },
    cached.permissionPublication
  )
  expect(permission.fact).toEqual({ mode: 'ask', fence: 8, revision: 0 })
})

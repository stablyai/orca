import { expect, it } from 'vitest'
import type { AgentChatPermissionMode } from './agent-chat-permission-mode'
import type { AgentSessionSubscribeEvent } from './agent-session-wire'
import { createStructuredAgentSessionEventCoalescer } from './structured-agent-session-coalescer'
import {
  EMPTY_SESSION_PERMISSION,
  observeSessionPermission,
  sessionPermissionView
} from './agent-session-permission-reducer'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from './structured-agent-session-reducer'

function frame(
  permissionMode?: AgentChatPermissionMode | null,
  permissionRevision?: number,
  fence = 7
): AgentSessionSubscribeEvent {
  return {
    type: 'batch',
    sessionId: 's',
    fence,
    batch: {
      cursor: { epoch: 'e', sequence: 1 },
      submissions: [],
      removedItemIds: [],
      items: [
        {
          itemId: 'a',
          revision: 1,
          sequence: 1,
          observedAt: 1,
          body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'output' }] }
        }
      ]
    },
    ...(permissionMode !== undefined ? { permissionMode, permissionRevision } : {})
  }
}

it.each([
  { modes: ['bypass', undefined], expected: 'bypass' },
  { modes: [undefined, 'bypass'], expected: 'bypass' },
  { modes: ['bypass', 'auto', 'ask'], expected: 'ask' },
  { modes: ['bypass', null, undefined], expected: null },
  { modes: [null, 'bypass'], expected: 'bypass' },
  { modes: [undefined, undefined], expected: 'ask' }
] satisfies {
  modes: (AgentChatPermissionMode | null | undefined)[]
  expected: AgentChatPermissionMode | null
}[])(
  'retains $expected through permission/output batches and the reducer ($modes)',
  ({ modes, expected }) => {
    const events: AgentSessionSubscribeEvent[] = []
    let state: StructuredAgentSessionState = {
      ...EMPTY_STRUCTURED_AGENT_SESSION,
      epoch: 'e',
      permissionMode: 'ask' as const
    }
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => {
      events.push(event)
      state = reduceStructuredAgentSession(state, { type: 'event', event })
    })
    modes.forEach((mode) => coalescer.push(frame(mode)))
    coalescer.flush()
    expect(events).toHaveLength(1)
    expect(state.permissionMode).toBe(expected)
    expect(state.items).toHaveLength(1)
    if (modes.every((mode) => mode === undefined)) {
      expect(events[0]).not.toHaveProperty('permissionMode')
    } else {
      expect(events[0]).toHaveProperty('permissionMode', expected)
    }
    coalescer.dispose()
  }
)

it('keeps the permission revision through token coalescing so narrowing supersedes older intent', () => {
  let transcript: StructuredAgentSessionState = {
    ...EMPTY_STRUCTURED_AGENT_SESSION,
    epoch: 'e',
    fence: 7
  }
  const events: AgentSessionSubscribeEvent[] = []
  const coalescer = createStructuredAgentSessionEventCoalescer((event) => {
    events.push(event)
    transcript = reduceStructuredAgentSession(transcript, { type: 'event', event })
  })
  coalescer.push(frame('bypass', 3))
  coalescer.push(frame())
  coalescer.push(frame('ask', 4))
  coalescer.push(frame())
  coalescer.flush()
  expect(events).toHaveLength(1)
  expect(transcript.permissionPublication).toEqual({ mode: 'ask', fence: 7, revision: 4 })
  let permission = observeSessionPermission(EMPTY_SESSION_PERMISSION, {
    mode: 'auto',
    fence: 7,
    revision: 2
  })
  permission = observeSessionPermission(permission, undefined, transcript.permissionPublication)
  expect(sessionPermissionView(permission, 'codex')?.current).toBe('ask')
  coalescer.dispose()
})

it('never relabels a permission publication with a later frame fence', () => {
  let transcript: StructuredAgentSessionState = {
    ...EMPTY_STRUCTURED_AGENT_SESSION,
    epoch: 'e',
    fence: 7
  }
  const events: AgentSessionSubscribeEvent[] = []
  const coalescer = createStructuredAgentSessionEventCoalescer((event) => {
    events.push(event)
    transcript = reduceStructuredAgentSession(transcript, { type: 'event', event })
  })
  coalescer.push(frame('bypass', 3))
  coalescer.push(frame(undefined, undefined, 8))
  coalescer.flush()
  expect(events).toHaveLength(2)
  expect(transcript.fence).toBe(8)
  expect(transcript.permissionPublication).toEqual({ mode: 'bypass', fence: 7, revision: 3 })
  const permission = observeSessionPermission(
    EMPTY_SESSION_PERMISSION,
    { mode: 'ask', fence: 8, revision: 0 },
    transcript.permissionPublication
  )
  expect(sessionPermissionView(permission, 'codex')?.current).toBe('ask')
  coalescer.dispose()
})

it('uses the revision of the selected mode without keeping metadata from another publication', () => {
  const events: AgentSessionSubscribeEvent[] = []
  const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event))
  coalescer.push(frame('ask', 4))
  coalescer.push(frame('bypass'))
  coalescer.flush()
  expect(events[0]).toHaveProperty('permissionMode', 'bypass')
  expect(events[0]).not.toHaveProperty('permissionRevision')
  coalescer.dispose()
})

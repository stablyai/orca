import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import { chatForkRecapMessages } from '../../../../../../../shared/agent-session/conversation-context/chat-fork-recap'
import {
  chatForkPath,
  chatForkSurfaceChoice
} from '../../../../../../../shared/native-chat/chat-fork-path'
import {
  defaultNativeChatForkAgent,
  nativeChatForkAgent,
  nativeChatForkHostChoices,
  nativeChatForkSurfaces
} from './native-chat-fork-window-choices'

const hosts = [
  { id: 'local' as const, label: 'This computer', capabilities: ['x'] },
  { id: 'runtime:new' as const, label: 'Studio', capabilities: ['y'] },
  { id: 'runtime:old' as const, label: 'Laptop', capabilities: [] },
  { id: 'runtime:off' as const, label: 'Server', capabilities: null }
]

function message(
  id: string,
  role: NativeChatMessage['role'],
  blocks: NativeChatMessage['blocks'] = []
): NativeChatMessage {
  return { id, role, blocks, timestamp: null, source: 'transcript' }
}

describe('defaultNativeChatForkAgent', () => {
  it('keeps the same agent unless it is out of usage', () => {
    expect(
      defaultNativeChatForkAgent({
        sourceAgent: 'claude',
        usageLimited: false,
        available: ['claude', 'codex']
      })
    ).toBe('claude')
  })

  it('picks an agent that does not share the limit when out of usage', () => {
    expect(
      defaultNativeChatForkAgent({
        sourceAgent: 'claude',
        usageLimited: true,
        available: ['claude', 'claude-agent-teams', 'codex', 'gemini'],
        preferred: 'gemini'
      })
    ).toBe('gemini')
    expect(
      defaultNativeChatForkAgent({
        sourceAgent: 'claude',
        usageLimited: true,
        available: ['claude-agent-teams', 'codex']
      })
    ).toBe('codex')
  })
})

describe('nativeChatForkAgent', () => {
  it('keeps a picked agent while another host detects its agents, and holds Enter until it answers', () => {
    const pick: Pick<Parameters<typeof nativeChatForkAgent>[0], 'picked' | 'sourceAgent'> = {
      picked: 'codex',
      sourceAgent: 'claude'
    }
    expect(
      nativeChatForkAgent({ ...pick, usageLimited: false, available: ['claude'], detecting: true })
    ).toEqual({
      agent: 'codex',
      settled: false
    })
    expect(
      nativeChatForkAgent({
        ...pick,
        usageLimited: false,
        available: ['claude', 'codex'],
        detecting: false
      })
    ).toEqual({ agent: 'codex', settled: true })
    expect(
      nativeChatForkAgent({ ...pick, usageLimited: false, available: ['claude'], detecting: false })
    ).toEqual({
      agent: 'claude',
      settled: true
    })
  })
})

describe('nativeChatForkHostChoices', () => {
  it('blocks only offline hosts: one that cannot import an exact copy still takes a recap', () => {
    expect(nativeChatForkHostChoices({ sourceHostId: 'local', hosts })).toEqual([
      { id: 'local', label: 'This computer', disabled: false },
      { id: 'runtime:new', label: 'Studio', disabled: false },
      { id: 'runtime:old', label: 'Laptop', disabled: false },
      { id: 'runtime:off', label: 'Server', disabled: true, blocked: 'offline' }
    ])
  })

  it('blocks an offline source host', () => {
    expect(nativeChatForkHostChoices({ sourceHostId: 'runtime:off', hosts })[0]).toEqual({
      id: 'runtime:off',
      label: 'Server',
      disabled: true,
      blocked: 'offline'
    })
  })
})

describe('chatForkPath', () => {
  const base = {
    sameAgent: true,
    sameHost: true,
    sameSurface: true,
    cutsHere: true,
    relays: true
  }
  it('cuts on the host for the same agent and kind', () => {
    expect(chatForkPath(base)).toBe('same')
  })
  it('relays the exact copy to another host or to the other kind', () => {
    expect(chatForkPath({ ...base, sameHost: false })).toBe('relay')
    expect(chatForkPath({ ...base, sameSurface: false })).toBe('relay')
    expect(chatForkPath({ ...base, cutsHere: false })).toBe('relay')
  })
  it('falls back to a recap where no exact copy can go, and for another agent', () => {
    expect(chatForkPath({ ...base, sameHost: false, relays: false })).toBe('recap')
    expect(chatForkPath({ ...base, sameSurface: false, relays: false })).toBe('recap')
    expect(chatForkPath({ ...base, sameAgent: false })).toBe('recap')
  })
})

describe('nativeChatForkSurfaces and chatForkSurfaceChoice', () => {
  it('keeps the chat’s own kind for the same agent on its host, and opens others only where the agent runs', () => {
    const surfaces = nativeChatForkSurfaces({
      sourceSurface: 'terminal',
      sameHost: true,
      sameAgent: true,
      agent: 'claude',
      chatAgents: ['codex'],
      cliAgents: []
    })
    expect(surfaces).toEqual({ chat: false, terminal: true })
    const elsewhere = nativeChatForkSurfaces({
      sourceSurface: 'terminal',
      sameHost: false,
      sameAgent: true,
      agent: 'claude',
      chatAgents: ['claude'],
      cliAgents: ['codex']
    })
    expect(elsewhere).toEqual({ chat: true, terminal: false })
    expect(
      chatForkSurfaceChoice({ sourceSurface: 'terminal', picked: undefined, available: elsewhere })
    ).toBe('chat')
  })

  it('honours a pick that is available and starts on nothing when neither kind is', () => {
    const both = { chat: true, terminal: true }
    expect(
      chatForkSurfaceChoice({ sourceSurface: 'chat', picked: 'terminal', available: both })
    ).toBe('terminal')
    expect(
      chatForkSurfaceChoice({
        sourceSurface: 'chat',
        picked: undefined,
        available: { chat: false, terminal: false }
      })
    ).toBeNull()
  })
})

describe('chatForkRecapMessages', () => {
  const clear = message('clear', 'system', [
    {
      type: 'text',
      text: 'Context cleared',
      contextClear: { operationId: 'op', afterFence: 1, clearedAt: 1 }
    }
  ])
  const compacted = message('compacted', 'system', [
    { type: 'text', text: 'Context compacted', presentation: 'compaction' }
  ])
  const messages = [
    message('u1', 'user'),
    message('a1', 'assistant'),
    message('a1-tools', 'assistant'),
    clear,
    message('u2', 'user'),
    message('a2', 'assistant'),
    compacted,
    message('u3', 'user'),
    message('a3', 'assistant')
  ]
  const ids = (found: readonly NativeChatMessage[] | null) => found?.map((entry) => entry.id)

  it('cuts after the fork point, keeping the rest of its turn', () => {
    expect(ids(chatForkRecapMessages(messages, 'a1'))).toEqual(['u1', 'a1', 'a1-tools'])
    expect(chatForkRecapMessages(messages, 'missing')).toBeNull()
  })

  it('hands over only what the agent held: after a clear, and from a compaction on', () => {
    expect(ids(chatForkRecapMessages(messages, 'a2', 'current'))).toEqual(['u2', 'a2'])
    expect(ids(chatForkRecapMessages(messages, 'a3', 'current'))).toEqual(['compacted', 'u3', 'a3'])
    expect(ids(chatForkRecapMessages(messages, 'a1', 'current'))).toEqual(['u1', 'a1', 'a1-tools'])
  })
})

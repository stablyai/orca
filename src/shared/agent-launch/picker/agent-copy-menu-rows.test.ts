import { expect, it } from 'vitest'
import { agentCopyMenuRows } from './agent-copy-menu-rows'

it('offers a copy as a chat and a CLI where its agent is, and nowhere else', () => {
  const copy = (id: string, agent: 'claude' | 'codex' | 'gemini' | 'grok') => ({
    id,
    name: id,
    agent
  })
  const rows = agentCopyMenuRows(
    [
      { kind: 'chat', agent: 'claude' },
      { kind: 'chat-unavailable', agent: 'codex', reason: 'wsl' },
      { kind: 'cli', agent: 'grok' }
    ],
    [
      copy('claude.a', 'claude'),
      copy('codex.b', 'codex'),
      copy('gemini.c', 'gemini'),
      copy('grok.d', 'grok')
    ],
    ['claude', 'codex', 'grok']
  )
  expect(rows.map((row) => `${row.kind}:${row.copy?.id}`)).toEqual([
    'chat:claude.a',
    'cli:claude.a',
    'cli:codex.b',
    'cli:grok.d'
  ])
})

it("leads with a chat only when the copy's own Chat | CLI choice says chat, and hides turned-off copies", () => {
  const rows = agentCopyMenuRows(
    [{ kind: 'chat', agent: 'claude' }],
    [
      { id: 'claude.chat', name: 'Chat', agent: 'claude', chat: true },
      { id: 'claude.cli', name: 'CLI', agent: 'claude', chat: false },
      { id: 'claude.off', name: 'Off', agent: 'claude', disabled: true }
    ],
    ['claude'],
    { nativeChatProviders: { claude: false } }
  )
  expect(
    rows.map((row) => `${row.kind}:${row.copy?.id}${'chat' in row && row.chat ? '+chat' : ''}`)
  ).toEqual(['chat:claude.chat', 'cli:claude.chat', 'cli:claude.cli+chat'])
})

it("does not offer this desktop's copies on a paired host, which would refuse their ids", () => {
  const rows = agentCopyMenuRows(
    [{ kind: 'chat', agent: 'claude', executionHostId: 'runtime:paired' }],
    [{ id: 'claude.a', name: 'A', agent: 'claude' }],
    ['claude']
  )
  expect(rows).toEqual([])
})

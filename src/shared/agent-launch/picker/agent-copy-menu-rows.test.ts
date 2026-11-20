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

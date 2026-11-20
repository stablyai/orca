import { expect, it } from 'vitest'
import { agentCopyMenuRows } from './agent-copy-menu-rows'

it("offers a copy on its agent's chat and CLI rows, or a terminal when the agent has none", () => {
  const copies = [
    { id: 'claude.code-mode', name: 'Claude code-mode', agent: 'claude' as const },
    { id: 'codex.fast', name: 'Codex fast', agent: 'codex' as const },
    { id: 'gemini.flash', name: 'Gemini flash', agent: 'gemini' as const }
  ]
  const rows = agentCopyMenuRows(
    [
      { kind: 'chat', agent: 'claude' },
      { kind: 'cli', agent: 'claude' },
      { kind: 'chat-unavailable', agent: 'codex', reason: 'wsl' }
    ],
    copies,
    ['claude', 'codex']
  )
  expect(rows).toEqual([
    { kind: 'chat', agent: 'claude', copy: { id: 'claude.code-mode', name: 'Claude code-mode' } },
    { kind: 'cli', agent: 'claude', copy: { id: 'claude.code-mode', name: 'Claude code-mode' } },
    { kind: 'terminal', agent: 'codex', copy: { id: 'codex.fast', name: 'Codex fast' } }
  ])
})

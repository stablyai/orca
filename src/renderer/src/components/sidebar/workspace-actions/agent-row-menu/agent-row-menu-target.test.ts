import { expect, it } from 'vitest'
import { isSameAgentRowMenuTarget, type AgentRowMenuTarget } from './agent-row-menu-target'

it('rejects a replacement agent in the same terminal pane', () => {
  const captured: AgentRowMenuTarget = {
    worktreeId: 'sample::/fixture',
    cardHostId: 'local',
    paneKey: 'tab:11111111-1111-4111-8111-111111111111',
    tabId: 'tab',
    kind: 'terminal',
    leafId: '11111111-1111-4111-8111-111111111111',
    unifiedTabId: 'tab-ui',
    chatSessionId: null,
    chatAgent: null,
    ptyId: 'pty-1',
    providerSessionId: 'session-1',
    singleLeaf: true
  }

  expect(isSameAgentRowMenuTarget(captured, { ...captured })).toBe(true)
  expect(isSameAgentRowMenuTarget(captured, { ...captured, ptyId: 'pty-2' })).toBe(false)
  expect(isSameAgentRowMenuTarget(captured, { ...captured, providerSessionId: 'session-2' })).toBe(
    false
  )
})

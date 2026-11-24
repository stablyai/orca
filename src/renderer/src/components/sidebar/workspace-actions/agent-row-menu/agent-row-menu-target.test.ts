import { expect, it } from 'vitest'
import { isSameAgentRowMenuTarget, type AgentRowMenuTarget } from './agent-row-menu-target'

it('rejects a replacement agent in the same terminal pane', () => {
  const captured: AgentRowMenuTarget = {
    worktreeId: 'sample::/fixture',
    cardHostId: 'local',
    paneKey: 'tab:11111111-1111-4111-8111-111111111111',
    tabId: 'tab',
    kind: 'terminal',
    executionHostId: null,
    leafId: '11111111-1111-4111-8111-111111111111',
    unifiedTabId: 'tab-ui',
    chatSessionId: null,
    chatAgent: null,
    ptyId: 'pty-1',
    providerSessionId: 'session-1',
    terminalHandle: null,
    hostPtyId: 'pty-1',
    singleLeaf: true
  }

  expect(isSameAgentRowMenuTarget(captured, { ...captured })).toBe(true)
  expect(isSameAgentRowMenuTarget(captured, { ...captured, ptyId: 'pty-2' })).toBe(false)
  expect(isSameAgentRowMenuTarget(captured, { ...captured, providerSessionId: 'session-2' })).toBe(
    false
  )
})

it('rejects a status row whose paired terminal handle changed', () => {
  const captured: AgentRowMenuTarget = {
    worktreeId: 'sample::/fixture',
    cardHostId: 'runtime:env-1',
    paneKey: 'tab:11111111-1111-4111-8111-111111111111',
    tabId: 'tab',
    kind: 'status',
    executionHostId: 'runtime:env-1',
    leafId: '11111111-1111-4111-8111-111111111111',
    unifiedTabId: null,
    chatSessionId: null,
    chatAgent: null,
    ptyId: null,
    providerSessionId: null,
    terminalHandle: 'handle-1',
    hostPtyId: null,
    singleLeaf: false
  }

  expect(isSameAgentRowMenuTarget(captured, { ...captured })).toBe(true)
  expect(isSameAgentRowMenuTarget(captured, { ...captured, terminalHandle: 'handle-2' })).toBe(
    false
  )
  expect(isSameAgentRowMenuTarget({ ...captured, terminalHandle: null }, captured)).toBe(false)
})

it('rejects a replaced tab PTY when the row resolved its host through it', () => {
  const captured: AgentRowMenuTarget = {
    worktreeId: 'sample::/fixture',
    cardHostId: 'local',
    paneKey: 'tab:11111111-1111-4111-8111-111111111111',
    tabId: 'tab',
    kind: 'terminal',
    executionHostId: null,
    leafId: '11111111-1111-4111-8111-111111111111',
    unifiedTabId: 'tab-ui',
    chatSessionId: null,
    chatAgent: null,
    ptyId: null,
    providerSessionId: 'session-1',
    terminalHandle: null,
    hostPtyId: 'pty-1',
    singleLeaf: true
  }

  expect(isSameAgentRowMenuTarget(captured, { ...captured })).toBe(true)
  expect(isSameAgentRowMenuTarget(captured, { ...captured, hostPtyId: 'pty-2' })).toBe(false)
})

it('keeps a chat when its first provider session arrives, and only a chat', () => {
  const chat: AgentRowMenuTarget = {
    worktreeId: 'sample::/fixture',
    cardHostId: 'local',
    paneKey: 'chat:22222222-2222-4222-8222-222222222222',
    tabId: 'chat-tab',
    kind: 'chat',
    executionHostId: 'local',
    leafId: null,
    unifiedTabId: 'chat-tab',
    chatSessionId: 'chat-session',
    chatAgent: 'codex',
    ptyId: null,
    providerSessionId: null,
    terminalHandle: null,
    hostPtyId: null,
    singleLeaf: true
  }
  const known = { ...chat, providerSessionId: 'session-1' }

  expect(isSameAgentRowMenuTarget(chat, known)).toBe(true)
  expect(isSameAgentRowMenuTarget(known, { ...chat, providerSessionId: 'session-2' })).toBe(false)
  expect(isSameAgentRowMenuTarget(known, chat)).toBe(false)
  expect(isSameAgentRowMenuTarget(chat, { ...known, chatSessionId: 'other-chat' })).toBe(false)
  const terminal: AgentRowMenuTarget = { ...chat, kind: 'terminal', executionHostId: null }
  expect(isSameAgentRowMenuTarget(terminal, { ...terminal, providerSessionId: 'session-1' })).toBe(
    false
  )
})

import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { makeLayout, makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { toRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  isSameAgentRowMenuTarget,
  resolveAgentRowMenuTarget,
  type AgentRowMenuTarget
} from './agent-row-menu-target'

afterEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
})

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

it.each([false, true])('rejects a replaced fallback PTY (has layout: %s)', (hasLayout) => {
  const leafId = '11111111-1111-4111-8111-111111111111'
  const ref = {
    worktreeId: 'sample::/fixture',
    cardHostId: 'runtime:env-1' as const,
    paneKey: `tab:${leafId}`,
    tabId: 'tab'
  }
  const first = toRemoteRuntimePtyId('first', 'env-1')
  useAppStore.setState({
    tabsByWorktree: { [ref.worktreeId]: [makeTab({ id: ref.tabId, worktreeId: ref.worktreeId })] },
    terminalLayoutsByTabId: hasLayout
      ? { [ref.tabId]: { ...makeLayout(), root: { type: 'leaf', leafId }, ptyIdsByLeafId: {} } }
      : {},
    ptyIdsByTabId: { [ref.tabId]: [first] }
  })
  const resolve = () => resolveAgentRowMenuTarget(useAppStore.getState(), ref)
  const captured = resolve()!
  expect(captured).toMatchObject({ kind: 'terminal', ptyId: null, hostPtyId: first })
  expect(isSameAgentRowMenuTarget(captured, resolve())).toBe(true)

  const replacement = toRemoteRuntimePtyId('replacement', 'env-1')
  useAppStore.setState({ ptyIdsByTabId: { [ref.tabId]: [replacement] } })
  const current = resolve()
  expect(current).toMatchObject({ kind: 'terminal', ptyId: null, hostPtyId: replacement })
  expect(isSameAgentRowMenuTarget(captured, current)).toBe(false)
})

it('accepts a first provider ID on the same chat and rejects a replacement', () => {
  const chat: Tab = {
    id: 'chat-tab',
    entityId: '22222222-2222-4222-8222-222222222222',
    worktreeId: 'sample::/fixture',
    executionHostId: 'local',
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    groupId: 'group',
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  const ref = {
    worktreeId: chat.worktreeId,
    cardHostId: 'local',
    paneKey: structuredAgentSessionPaneKey(chat.id, chat.entityId),
    tabId: chat.id
  } as const
  const resolve = () => resolveAgentRowMenuTarget(useAppStore.getState(), ref)
  const publish = (providerId: string) => {
    useAppStore
      .getState()
      .setAgentStatus(
        ref.paneKey,
        { state: 'working', agentType: 'codex', prompt: 'Fixture chat' },
        undefined,
        undefined,
        { tabId: chat.id, worktreeId: chat.worktreeId },
        { providerSession: { key: 'session_id', id: providerId } }
      )
  }
  useAppStore.setState({ unifiedTabsByWorktree: { [chat.worktreeId]: [chat] } })
  const captured = resolve()!
  expect(captured).toMatchObject({ kind: 'chat', providerSessionId: null })

  const firstProviderId = '33333333-3333-4333-8333-333333333333'
  publish(firstProviderId)
  const known = resolve()!
  expect(known).toMatchObject({ kind: 'chat', providerSessionId: firstProviderId })
  expect(isSameAgentRowMenuTarget(captured, known)).toBe(true)

  const replacementProviderId = '44444444-4444-4444-8444-444444444444'
  publish(replacementProviderId)
  const current = resolve()
  expect(current).toMatchObject({ kind: 'chat', providerSessionId: replacementProviderId })
  expect(isSameAgentRowMenuTarget(known, current)).toBe(false)

  useAppStore.setState({
    unifiedTabsByWorktree: {
      [chat.worktreeId]: [{ ...chat, entityId: '55555555-5555-4555-8555-555555555555' }]
    }
  })
  expect(resolve()).toBeNull()
  expect(isSameAgentRowMenuTarget(captured, resolve())).toBe(false)
})

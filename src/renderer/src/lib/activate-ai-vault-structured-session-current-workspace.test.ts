import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../shared/tab-types'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from './worktree-activation-created-agent.test-fixture'
import { registerWorktreeActivationReset } from './worktree-activation.test-fixture'

const mocks = vi.hoisted(() => ({
  resume: vi.fn(),
  call: vi.fn(async () => ({ ok: true }))
}))
// Workspace activation and its agent gate both wake sleeping agents through this entry.
vi.mock('@/lib/resume-sleeping-agent-session', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resumeSleepingAgentSessionsForWorktree: mocks.resume
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  callRuntimeRpc: mocks.call
}))

import { activateAiVaultStructuredSession } from './activate-ai-vault-structured-session'

const initialAppStoreState = useAppStore.getState()
registerWorktreeActivationReset()
afterEach(() => {
  vi.clearAllMocks()
  useAppStore.setState(initialAppStoreState, true)
})

it('selects a chat in the active workspace without waking its other sleeping agents', async () => {
  const worktree = makeCreatedAgentWorktree()
  seedEmptyActivatableWorktree(worktree)
  const chat: Tab = {
    id: 'agent-session:chat-a',
    worktreeId: worktree.id,
    entityId: 'chat-a',
    executionHostId: 'local',
    groupId: 'group',
    contentType: 'agent-session',
    label: 'Codex Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  useAppStore.setState({
    activeWorktreeId: worktree.id,
    unifiedTabsByWorktree: { [worktree.id]: [chat] },
    groupsByWorktree: {
      [worktree.id]: [
        { id: 'group', worktreeId: worktree.id, tabOrder: [chat.id], activeTabId: null }
      ]
    }
  })

  await expect(
    activateAiVaultStructuredSession({
      structuredSession: { workspaceId: worktree.id, sessionId: 'chat-a' }
    })
  ).resolves.toBe(true)

  expect(useAppStore.getState().groupsByWorktree[worktree.id]?.[0]?.activeTabId).toBe(chat.id)
  expect(mocks.resume).not.toHaveBeenCalled()
})

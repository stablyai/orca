import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import * as sleepingResume from './resume-sleeping-agent-session'
import { waitForWorktreeAgentActivationGateForTests } from './worktree-agent-activation-gate'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from './worktree-activation-created-agent.test-fixture'
import { registerWorktreeActivationReset } from './worktree-activation.test-fixture'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  callRuntimeRpc: mocks.call,
  runtimeEnvironmentSupportsCapability: async () => true
}))
vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionWorktreeTabs: async () => undefined
}))

import { activateAiVaultStructuredSession } from './activate-ai-vault-structured-session'

const initialAppStoreState = useAppStore.getState()
registerWorktreeActivationReset()
const destination = makeCreatedAgentWorktree()
const other: Worktree = { ...destination, id: 'repo-1::/workspace/other', path: '/workspace/other' }
// An unrelated CLI agent asleep in the destination, exactly what activation would resume.
const sleeping = {
  paneKey: 'saved-tab:11111111-1111-4111-8111-111111111111',
  tabId: 'saved-tab',
  worktreeId: destination.id,
  agent: 'omp' as const,
  providerSession: { key: 'session_id' as const, id: 'saved-omp-session' },
  prompt: 'resume',
  state: 'working' as const,
  capturedAt: 1,
  updatedAt: 1
}
const chat = (worktreeId: string, executionHostId: Tab['executionHostId'] = 'local'): Tab => ({
  id: `agent-session:chat-a:${executionHostId}`,
  worktreeId,
  entityId: 'chat-a',
  executionHostId,
  groupId: 'group',
  contentType: 'agent-session',
  label: 'Codex Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
})
let resume: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  seedEmptyActivatableWorktree(destination, { extraWorktrees: [other] })
  const tab = chat(destination.id)
  useAppStore.setState({
    workspaceSessionReady: true,
    terminalStartupRestorationReady: true,
    ptyIdsByTabId: {},
    automaticAgentResumeClaimsByTabId: {},
    agentStatusByPaneKey: {},
    sleepingAgentSessionsByPaneKey: { [sleeping.paneKey]: sleeping },
    unifiedTabsByWorktree: { [destination.id]: [tab] },
    groupsByWorktree: {
      [destination.id]: [
        { id: 'group', worktreeId: destination.id, tabOrder: [tab.id], activeTabId: null }
      ]
    }
  })
  // The activation gate's real inventory reads: nothing else runs in this workspace.
  vi.stubGlobal('window', {
    api: {
      runtime: {
        call: vi.fn(async ({ method }: { method: string }) => ({
          ok: true,
          result:
            method === 'terminal.list'
              ? {
                  terminals: [],
                  truncated: false,
                  hostScope: { hostIds: ['local'], omittedHostIds: [] }
                }
              : method === 'agentSession.handoffStatus'
                ? { owner: 'native' }
                : {
                    worktree: destination.id,
                    publicationEpoch: 'navigation-test',
                    snapshotVersion: 1,
                    activeGroupId: null,
                    activeTabId: null,
                    activeTabType: null,
                    tabs: [
                      {
                        type: 'agent-session',
                        id: 'agent-session:chat-a',
                        title: 'Codex Chat',
                        sessionId: 'chat-a',
                        agent: 'codex',
                        isActive: false
                      }
                    ]
                  }
        }))
      },
      pty: { listSessions: vi.fn(async () => []) }
    }
  })
  resume = vi.spyOn(sleepingResume, 'resumeSleepingAgentSessionsForWorktree').mockReturnValue(1)
  mocks.call.mockResolvedValue({ ok: true })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

const open = (workspaceId = destination.id, executionHostId?: string) =>
  activateAiVaultStructuredSession({
    structuredSession: { workspaceId, sessionId: 'chat-a' },
    ...(executionHostId ? { executionHostId } : {})
  })
const shownChat = () => useAppStore.getState().groupsByWorktree[destination.id]?.[0]?.activeTabId

it('opens a chat in the workspace on screen without waking its other sleeping agents', async () => {
  useAppStore.setState({ activeWorktreeId: destination.id, activeView: 'settings' })

  await expect(open()).resolves.toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(shownChat()).toBe(chat(destination.id).id)
  expect(useAppStore.getState().activeView).toBe('terminal')
  await expect(waitForWorktreeAgentActivationGateForTests(destination.id)).resolves.toBeNull()
  expect(resume).not.toHaveBeenCalled()
  expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[sleeping.paneKey]).toBe(sleeping)
})

it('wakes the destination like any workspace switch when the chat is opened from another one', async () => {
  useAppStore.setState({ activeWorktreeId: other.id })

  await expect(open()).resolves.toBe(true)

  expect(useAppStore.getState().activeWorktreeId).toBe(destination.id)
  expect(shownChat()).toBe(chat(destination.id).id)
  // Resumed through the activation gate, which names the claims it skips.
  await vi.waitFor(() =>
    expect(resume).toHaveBeenCalledExactlyOnceWith(destination.id, { skipClaimKeys: new Set() })
  )
})

it('asks the host for the chat when its saved workspace is no longer registered', async () => {
  const retired = `retired-project::${destination.path}`
  useAppStore.setState({
    activeWorktreeId: retired,
    unifiedTabsByWorktree: { [retired]: [chat(retired)] },
    groupsByWorktree: {}
  })
  mocks.call.mockImplementation(async (_host, method: string) => {
    if (method === 'orchestration.partyLocation') {
      return { location: { kind: 'chat', sessionId: 'chat-a', worktreeId: retired } }
    }
    if (method === 'agentSession.reveal') {
      const tab = chat(destination.id)
      useAppStore.setState({
        unifiedTabsByWorktree: { [destination.id]: [tab] },
        groupsByWorktree: {
          [destination.id]: [
            { id: 'group', worktreeId: destination.id, tabOrder: [tab.id], activeTabId: null }
          ]
        }
      })
      return { ok: true, sessionId: 'chat-a', workspaceId: destination.id, agent: 'codex' }
    }
    return { ok: true }
  })

  await expect(open(retired)).resolves.toBe(true)

  expect(mocks.call.mock.calls.map((call) => call[1])).toContain('agentSession.reveal')
  expect(useAppStore.getState().activeWorktreeId).toBe(destination.id)
  expect(shownChat()).toBe(chat(destination.id).id)
})

it('selects the chat host when another host shows the same workspace ID', async () => {
  const remote = { ...destination, hostId: 'runtime:env-1' as const }
  const tab = chat(destination.id, 'runtime:env-1')
  useAppStore.setState({
    worktreesByRepo: { [destination.repoId]: [destination, remote] },
    activeWorktreeId: destination.id,
    activeWorkspaceExecutionHostId: 'local',
    sleepingAgentSessionsByPaneKey: {},
    unifiedTabsByWorktree: { [destination.id]: [chat(destination.id), tab] },
    groupsByWorktree: {
      [destination.id]: [
        { id: 'group', worktreeId: destination.id, tabOrder: [tab.id], activeTabId: null }
      ]
    }
  })

  await expect(open(destination.id, 'runtime:env-1')).resolves.toBe(true)

  expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe('runtime:env-1')
  expect(shownChat()).toBe(tab.id)
})

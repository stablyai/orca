import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import * as sleepingResume from './resume-sleeping-agent-session'
import * as pruneModule from './retire-moved-structured-session-placement'
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

const open = (workspaceId = destination.id, executionHostId?: ExecutionHostId) =>
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

/** A copy of `row` whose own fields count each read. */
function counted<T extends object>(row: T, reads: { count: number }): T {
  const copy = { ...row }
  for (const [key, value] of Object.entries(row)) {
    Object.defineProperty(copy, key, {
      enumerable: true,
      get: () => {
        reads.count++
        return value
      }
    })
  }
  return copy
}

it.each([
  { owner: 'stamped', executionHostId: 'local' as const },
  { owner: 'legacy', executionHostId: undefined }
])(
  'a moved reveal over N and 10N unrelated workspaces prunes its one old tab in one write ($owner owner)',
  async ({ executionHostId }) => {
    const retired = `retired-project::${destination.path}`
    const tally: Record<string, number[]> = {}
    for (const n of [20, 200]) {
      const catalogReads = { count: 0 }
      const unrelatedReads = { count: 0 }
      const unrelated = Array.from({ length: n }, (_, i) =>
        counted(
          { ...other, id: `repo-1::/workspace/u${i}`, path: `/workspace/u${i}` },
          catalogReads
        )
      )
      seedEmptyActivatableWorktree(destination, { extraWorktrees: [other, ...unrelated] })
      const moved = { ...chat(retired), executionHostId }
      // The old workspace keeps N other chats beside the moved one, in its group and tab bar.
      const kept = Array.from({ length: n }, (_, i) => ({
        ...chat(retired),
        id: `kept-${i}`,
        entityId: `kept-chat-${i}`
      }))
      const unrelatedTabs = Object.fromEntries(
        unrelated.map((row) => [row.id, [counted(chat(row.id), unrelatedReads)]])
      )
      useAppStore.setState({
        activeWorktreeId: retired,
        sleepingAgentSessionsByPaneKey: {},
        unifiedTabsByWorktree: { ...unrelatedTabs, [retired]: [moved, ...kept] },
        groupsByWorktree: {
          [retired]: [
            {
              id: 'group',
              worktreeId: retired,
              tabOrder: [moved.id, ...kept.map((tab) => tab.id)],
              activeTabId: moved.id
            }
          ]
        },
        tabBarOrderByWorktree: { [retired]: [moved.id, ...kept.map((tab) => tab.id)] }
      })
      mocks.call.mockImplementation(async (_host, method: string) => {
        if (method === 'orchestration.partyLocation') {
          return { location: { kind: 'chat', sessionId: 'chat-a', worktreeId: retired } }
        }
        if (method === 'agentSession.reveal') {
          const tab = chat(destination.id)
          useAppStore.setState((state) => ({
            unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, [destination.id]: [tab] },
            groupsByWorktree: {
              ...state.groupsByWorktree,
              [destination.id]: [
                { id: 'group', worktreeId: destination.id, tabOrder: [tab.id], activeTabId: null }
              ]
            }
          }))
          return { ok: true, sessionId: 'chat-a', workspaceId: destination.id, agent: 'codex' }
        }
        return { ok: true }
      })
      const unrelatedEntry = useAppStore.getState().unifiedTabsByWorktree[unrelated[0]!.id]
      let pruning = false
      let pruneWrites = 0
      const prune = pruneModule.retireMovedSessionPlacement
      vi.spyOn(pruneModule, 'retireMovedSessionPlacement').mockImplementation((...args) => {
        pruning = true
        try {
          prune(...args)
        } finally {
          pruning = false
        }
      })
      const setState = useAppStore.setState
      vi.spyOn(useAppStore, 'setState').mockImplementation((...args) => {
        pruneWrites += pruning ? 1 : 0
        return setState(...args)
      })
      resume.mockClear()
      catalogReads.count = 0
      unrelatedReads.count = 0

      await expect(open(retired)).resolves.toBe(true)

      const state = useAppStore.getState()
      expect(state.activeWorktreeId).toBe(destination.id)
      expect(shownChat()).toBe(chat(destination.id).id)
      expect(state.unifiedTabsByWorktree[retired]?.map((tab) => tab.id)).toEqual(
        kept.map((tab) => tab.id)
      )
      expect(state.groupsByWorktree[retired]?.[0]?.tabOrder).toEqual(kept.map((tab) => tab.id))
      expect(state.tabBarOrderByWorktree[retired]).toEqual(kept.map((tab) => tab.id))
      // An unrelated workspace's entry is the same object, so its selector does not change.
      expect(state.unifiedTabsByWorktree[unrelated[0]!.id]).toBe(unrelatedEntry)
      await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce())
      const writes = pruneWrites
      // A repeat finds nothing to prune and writes nothing.
      prune('chat-a', retired, destination.id, { kind: 'local' })
      expect(useAppStore.getState().unifiedTabsByWorktree[retired]).toBe(
        state.unifiedTabsByWorktree[retired]
      )
      for (const [key, value] of Object.entries({
        pruneWrites: writes,
        unrelatedTabReads: unrelatedReads.count,
        catalogReads: catalogReads.count
      })) {
        ;(tally[key] ??= []).push(value)
      }
      vi.restoreAllMocks()
      resume = vi.spyOn(sleepingResume, 'resumeSleepingAgentSessionsForWorktree').mockReturnValue(1)
    }
    console.log('S3_OPENER_COUNTS', JSON.stringify({ executionHostId, tally }))
    // The opener prunes after the reveal and again at settlement; only the first finds the tab.
    expect(tally.pruneWrites).toEqual([1, 1])
    expect(tally.unrelatedTabReads).toEqual([0, 0])
    expect(tally.catalogReads![1]).toBeLessThanOrEqual(12 * Math.max(tally.catalogReads![0]!, 1))
  }
)

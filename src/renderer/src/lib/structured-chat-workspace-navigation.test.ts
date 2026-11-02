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

/** A copy of `items` that counts each element read. */
function countedOrder(items: string[], reads: { count: number }): string[] {
  return new Proxy(items, {
    get: (target, key) => {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        reads.count++
      }
      return target[key as keyof string[]]
    }
  })
}

type PruneCase = { owner: string; executionHostId: ExecutionHostId | undefined; site: string }

/** N unrelated listed workspaces with a chat each, and an old key holding the moved chat beside N
 *  kept chats, chat C, an editor and another host's tab of the same chat in two groups with MRU. */
function prunePopulation(n: number, executionHostId: ExecutionHostId | undefined) {
  const retired = `retired-project::${destination.path}`
  const reads = { catalog: { count: 0 }, unrelated: { count: 0 }, old: { count: 0 } }
  const orderReads = { count: 0 }
  const unrelated = Array.from({ length: n }, (_, i) =>
    counted({ ...other, id: `repo-1::/workspace/u${i}`, path: `/workspace/u${i}` }, reads.catalog)
  )
  seedEmptyActivatableWorktree(destination, { extraWorktrees: [other, ...unrelated] })
  const old = (tab: Tab) => counted(tab, reads.old)
  const moved = old({ ...chat(retired), executionHostId })
  const kept = Array.from({ length: n }, (_, i) =>
    old({ ...chat(retired), id: `kept-${i}`, entityId: `kept-chat-${i}` })
  )
  const chatC = old({ ...chat(retired), id: 'chat-c-tab', entityId: 'chat-c' })
  const editor = old({
    ...chat(retired),
    id: 'editor-tab',
    entityId: '/file',
    contentType: 'editor'
  })
  // Another host's tab of the same chat: not this owner's copy, so it stays.
  const foreign = old({ ...chat(retired), id: 'foreign-a', executionHostId: 'runtime:env-9' })
  const half = kept.slice(0, n / 2).map((tab) => tab.id)
  const rest = kept.slice(n / 2).map((tab) => tab.id)
  const ids = [moved, ...kept, chatC, editor, foreign].map((tab) => tab.id)
  const unrelatedTabs = Object.fromEntries(
    unrelated.map((row) => [row.id, [counted(chat(row.id), reads.unrelated)]])
  )
  const order = (items: string[]) => countedOrder(items, orderReads)
  useAppStore.setState({
    sleepingAgentSessionsByPaneKey: {},
    unifiedTabsByWorktree: {
      ...unrelatedTabs,
      [retired]: [moved, ...kept, chatC, editor, foreign]
    },
    groupsByWorktree: {
      [retired]: [
        {
          id: 'group',
          worktreeId: retired,
          tabOrder: order([moved.id, ...half, chatC.id]),
          recentTabIds: order([...half, moved.id]),
          activeTabId: moved.id
        },
        {
          id: 'group-b',
          worktreeId: retired,
          tabOrder: order([...rest, editor.id, foreign.id]),
          recentTabIds: order([foreign.id, editor.id]),
          activeTabId: editor.id
        }
      ]
    },
    tabBarOrderByWorktree: { [retired]: order(ids) }
  })
  // References the old key holds: its tabs, both groups' orders and MRU, and its tab bar.
  const references = 2 * ids.length + n / 2 + 3
  return { retired, reads, orderReads, unrelated, kept, chatC, editor, foreign, half, references }
}

const destinationTab = () => {
  const tab = chat(destination.id)
  return {
    unifiedTab: tab,
    group: { id: 'group', worktreeId: destination.id, tabOrder: [tab.id], activeTabId: null }
  }
}

it.each<PruneCase>([
  { owner: 'stamped', executionHostId: 'local', site: 'reveal' },
  { owner: 'legacy', executionHostId: undefined, site: 'reveal' },
  { owner: 'stamped', executionHostId: 'local', site: 'settlement' },
  { owner: 'legacy', executionHostId: undefined, site: 'settlement' }
])(
  'a moved open over N and 10N unrelated workspaces prunes its one old tab in one write ($owner owner, $site prune)',
  async ({ executionHostId, site }) => {
    const tally: Record<string, number[]> = {}
    const budgets: Record<string, number[]> = {}
    for (const n of [20, 200]) {
      const population = prunePopulation(n, executionHostId)
      const { retired, reads, orderReads, unrelated } = population
      const placeDestination = () => {
        const { unifiedTab, group } = destinationTab()
        useAppStore.setState((state) => ({
          unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, [destination.id]: [unifiedTab] },
          groupsByWorktree: { ...state.groupsByWorktree, [destination.id]: [group] }
        }))
      }
      if (site === 'settlement') {
        // The host already lists the chat at its new workspace, which is on screen: the open
        // needs no reveal, and the settled open drops the old copy.
        placeDestination()
        useAppStore.setState({
          activeWorktreeId: destination.id,
          activeWorkspaceExecutionHostId: 'local'
        })
      } else {
        useAppStore.setState({ activeWorktreeId: retired })
      }
      mocks.call.mockImplementation(async (_host, method: string) => {
        if (method === 'orchestration.partyLocation') {
          const worktreeId = site === 'settlement' ? destination.id : retired
          return { location: { kind: 'chat', sessionId: 'chat-a', worktreeId } }
        }
        if (method === 'agentSession.reveal') {
          placeDestination()
          return { ok: true, sessionId: 'chat-a', workspaceId: destination.id, agent: 'codex' }
        }
        return { ok: true }
      })
      const affected = () => useAppStore.getState().unifiedTabsByWorktree[retired]
      const unrelatedEntry = () => useAppStore.getState().unifiedTabsByWorktree[unrelated[0]!.id]
      const changes = { affected: 0, unrelated: 0 }
      let seen = { affected: affected(), unrelated: unrelatedEntry() }
      const unsubscribe = useAppStore.subscribe(() => {
        changes.affected += affected() === seen.affected ? 0 : 1
        changes.unrelated += unrelatedEntry() === seen.unrelated ? 0 : 1
        seen = { affected: affected(), unrelated: unrelatedEntry() }
      })
      let pruning = false
      const prunes = { calls: 0, writes: 0, mapsCopied: 0, keysCopied: 0 }
      const prune = pruneModule.retireMovedSessionPlacement
      vi.spyOn(pruneModule, 'retireMovedSessionPlacement').mockImplementation((...args) => {
        prunes.calls++
        pruning = true
        try {
          prune(...args)
        } finally {
          pruning = false
        }
      })
      const setState = useAppStore.setState
      vi.spyOn(useAppStore, 'setState').mockImplementation((...args) => {
        if (pruning) {
          prunes.writes++
          // The pruner copies a root map once when it changes one of its entries.
          const before = useAppStore.getState()
          const written = args[0] as Partial<typeof before>
          for (const key of [
            'unifiedTabsByWorktree',
            'groupsByWorktree',
            'tabBarOrderByWorktree'
          ] as const) {
            if (written[key] && written[key] !== before[key]) {
              prunes.mapsCopied++
              prunes.keysCopied += Object.keys(before[key]).length
            }
          }
        }
        return setState(...args)
      })
      resume.mockClear()
      mocks.call.mockClear()
      for (const counter of [reads.catalog, reads.unrelated, reads.old, orderReads]) {
        counter.count = 0
      }

      await expect(open(retired)).resolves.toBe(true)

      unsubscribe()
      const state = useAppStore.getState()
      expect(state.activeWorktreeId).toBe(destination.id)
      expect(state.activeWorkspaceExecutionHostId).toBe('local')
      expect(state.activeView).toBe('terminal')
      expect(shownChat()).toBe(chat(destination.id).id)
      expect(mocks.call.mock.calls.some((call) => call[1] === 'agentSession.reveal')).toBe(
        site === 'reveal'
      )
      const keptIds = population.kept.map((tab) => tab.id)
      // Everything else in the old workspace stays, in order: N chats, C, the editor and the
      // other host's tab of the same chat.
      expect(state.unifiedTabsByWorktree[retired]?.map((tab) => tab.id)).toEqual([
        ...keptIds,
        population.chatC.id,
        population.editor.id,
        population.foreign.id
      ])
      const [group, groupB] = state.groupsByWorktree[retired]!
      expect([...group!.tabOrder]).toEqual([...population.half, population.chatC.id])
      expect([...(group!.recentTabIds ?? [])]).toEqual(population.half)
      expect(group!.activeTabId).toBe(population.half.at(-1))
      expect(groupB!.activeTabId).toBe(population.editor.id)
      expect([...state.tabBarOrderByWorktree[retired]!]).toEqual([
        ...keptIds,
        population.chatC.id,
        population.editor.id,
        population.foreign.id
      ])
      expect(changes).toEqual({ affected: 1, unrelated: 0 })
      // A switch wakes the destination once; a chat opened where the user already is wakes nothing.
      await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(site === 'settlement' ? 0 : 1))
      const measured = { ...prunes }
      // A repeat finds nothing to prune and writes nothing.
      prune('chat-a', retired, destination.id, { kind: 'local' })
      expect(useAppStore.getState().unifiedTabsByWorktree[retired]).toBe(
        state.unifiedTabsByWorktree[retired]
      )
      const workspaces = Object.keys(state.unifiedTabsByWorktree).length
      const counts = {
        pruneCalls: measured.calls,
        pruneWrites: measured.writes,
        mapsCopied: measured.mapsCopied,
        keysCopied: measured.keysCopied,
        oldKeyTabReads: reads.old.count,
        oldKeyOrderReads: orderReads.count,
        unrelatedTabReads: reads.unrelated.count,
        catalogReads: reads.catalog.count
      }
      for (const [key, value] of Object.entries(counts)) {
        ;(tally[key] ??= []).push(value)
      }
      // Fixed overhead plus a constant per supplied element, per phase.
      const budget = {
        keysCopied: 3 * workspaces + 3,
        oldKeyTabReads: 64 + 24 * (n + 4),
        oldKeyOrderReads: 16 + 4 * population.references,
        catalogReads: 64 + 2 * (n + 2)
      }
      for (const [key, value] of Object.entries(budget)) {
        ;(budgets[key] ??= []).push(value)
        expect(counts[key as keyof typeof counts]).toBeLessThanOrEqual(value)
      }
      vi.restoreAllMocks()
      resume = vi.spyOn(sleepingResume, 'resumeSleepingAgentSessionsForWorktree').mockReturnValue(1)
    }
    console.log('S3_OPENER_COUNTS', JSON.stringify({ executionHostId, site, tally, budgets }))
    // Both production call sites run (after the reveal, if any, and at settlement); one prunes.
    expect(tally.pruneCalls).toEqual(site === 'reveal' ? [2, 2] : [1, 1])
    expect(tally.pruneWrites).toEqual([1, 1])
    expect(tally.mapsCopied).toEqual([3, 3])
    expect(tally.unrelatedTabReads).toEqual([0, 0])
    for (const key of ['keysCopied', 'oldKeyTabReads', 'oldKeyOrderReads', 'catalogReads']) {
      expect(tally[key]![1]).toBeLessThanOrEqual(12 * Math.max(tally[key]![0]!, 1))
    }
  }
)

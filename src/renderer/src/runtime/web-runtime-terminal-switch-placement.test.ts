import { observeSessionTabPlacementWork } from '../../../shared/session-tab-placement-work.test-fixture'
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import { createWebRuntimeSessionTerminalResult } from './web-runtime-terminal-create-operation'
import { refreshWebRuntimeSessionTabsSnapshot } from './web-runtime-session-snapshot'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'

const ENV = 'paired-placement',
  WT = 'repo::/repo'
const chat = (id: string) => ({
  type: 'agent-session' as const,
  id: `agent-session:${id}`,
  sessionId: id,
  agent: 'codex' as const,
  title: id,
  isActive: false
})
let frame: RuntimeMobileSessionTabsResult
function resetFrame(n = 0) {
  resetWebSessionTabsSnapshotFreshnessForTests()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeWorktreeId: WT,
    activeWorkspaceExecutionHostId: `runtime:${ENV}`,
    settings: createGlobalSettingsFixture({
      ...useAppStore.getState().settings,
      activeRuntimeEnvironmentId: ENV
    })
  })
  const source = n
    ? Array.from({ length: n }, (_, i) => (i === n / 2 ? 'C' : `old-${i}`))
    : ['A', 'C', 'B']
  frame = {
    worktree: WT,
    publicationEpoch: 'host-placement',
    snapshotVersion: 1,
    activeGroupId: 'R',
    activeTabId: 'agent-session:D',
    activeTabType: 'agent-session',
    tabs: [...source, 'D'].map(chat),
    tabGroups: [
      {
        id: 'L',
        activeTabId: 'agent-session:C',
        tabOrder: source.map((id) => `agent-session:${id}`)
      },
      { id: 'R', activeTabId: 'agent-session:D', tabOrder: ['agent-session:D'] }
    ]
  }
  useAppStore.setState((state) => applyWebSessionTabsSnapshot(state, frame, ENV))
}
beforeEach(() => resetFrame())
afterEach(() => vi.restoreAllMocks())
it.each([
  { pinned: false, n: 0 },
  { pinned: true, n: 0 },
  { pinned: false, n: 32 },
  { pinned: false, n: 320 }
])(
  'keeps client neighbors and pin partitions through early retirement and refresh (pinned: $pinned/$n)',
  async ({ pinned, n }) => {
    const current = Array.from({ length: n }, (_, i) => `current-${i}`)
    if (n) {
      resetFrame(n)
    }
    const work = observeSessionTabPlacementWork()
    if (pinned) {
      frame = {
        ...frame,
        snapshotVersion: frame.snapshotVersion + 1,
        tabs: [
          ...frame.tabs.map((tab) => ({
            ...tab,
            isPinned: ['agent-session:A', 'agent-session:C', 'agent-session:B'].includes(tab.id)
          })),
          chat('U')
        ],
        tabGroups: frame.tabGroups?.map((group) =>
          group.id === 'L' ? { ...group, tabOrder: [...group.tabOrder, 'agent-session:U'] } : group
        )
      }
      useAppStore.setState((state) => applyWebSessionTabsSnapshot(state, frame, ENV))
    }
    const before = useAppStore.getState()
    const source = before.unifiedTabsByWorktree[WT].find((tab) => tab.entityId === 'C')!
    const sourceGroup = source.groupId
    const runtimeCall = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'session.tabs.createTerminal') {
        frame = {
          ...frame,
          snapshotVersion: frame.snapshotVersion + 1,
          tabs: [
            ...(n
              ? [...current, 'D'].map(chat)
              : frame.tabs.filter((tab) => tab.id !== 'agent-session:C')),
            {
              type: 'terminal',
              id: 'T::leaf',
              parentTabId: 'T',
              leafId: 'leaf',
              title: 'Terminal',
              terminal: 'term_T',
              isActive: false,
              status: 'ready'
            }
          ],
          tabGroups: [
            {
              id: 'L',
              activeTabId: 'T',
              tabOrder: [
                ...(n
                  ? current.map((id) => `agent-session:${id}`)
                  : ['agent-session:A', 'agent-session:B']),
                'T',
                ...(pinned ? ['agent-session:U'] : [])
              ]
            },
            frame.tabGroups![1]
          ]
        }
        // Publication beats the create response, with C already gone and T at the host's old fallback.
        useAppStore.setState((state) => applyWebSessionTabsSnapshot(state, frame, ENV))
        expect(
          useAppStore.getState().unifiedTabsByWorktree[WT].some((tab) => tab.entityId === 'C')
        ).toBe(false)
        useAppStore.getState().createUnifiedTab(WT, 'editor', {
          id: 'concurrent',
          entityId: '/repo/concurrent',
          targetGroupId: sourceGroup
        })
        return { id: 'create', ok: true as const, result: { tab: frame.tabs.at(-1) } }
      }
      if (method === 'session.tabs.list') {
        return { id: 'list', ok: true as const, result: frame }
      }
      throw new Error(`Unexpected ${method}`)
    })
    Object.assign(window, {
      api: {
        ...window.api,
        runtimeEnvironments: { ...window.api?.runtimeEnvironments, call: runtimeCall }
      }
    })
    const result = await createWebRuntimeSessionTerminalResult({
      environmentId: ENV,
      worktreeId: WT,
      afterTabId: source.id,
      targetGroupId: sourceGroup,
      launchAgent: 'codex',
      command: 'codex resume conversation',
      resumeOrigin: 'switch',
      providerSession: { key: 'session_id', id: 'conversation' },
      selectWorktree: false,
      activate: true
    })
    expect(result.outcome.status).toBe('created')
    const order = () =>
      useAppStore.getState().groupsByWorktree[WT].find((group) => group.id === sourceGroup)!
        .tabOrder
    const expected = n
      ? [
          ...current.slice(0, n / 2 + 1).map((id) => `structured-agent-session-${id}`),
          toWebTerminalSurfaceTabId('T'),
          ...current.slice(n / 2 + 1).map((id) => `structured-agent-session-${id}`),
          'concurrent'
        ]
      : [
          'structured-agent-session-A',
          ...(pinned ? ['structured-agent-session-B'] : []),
          toWebTerminalSurfaceTabId('T'),
          ...(pinned ? ['structured-agent-session-U'] : ['structured-agent-session-B']),
          'concurrent'
        ]
    expect(order()).toEqual(expected)
    expect(useAppStore.getState().activeGroupIdByWorktree[WT]).toBe(sourceGroup)
    if (n) {
      console.info('PAIRED_PLACEMENT_WORK', JSON.stringify({ n, samples: work.samples }))
      expect(work.samples.length).toBeGreaterThan(0)
      for (const sample of work.samples) {
        expect(sample.reads + sample.adds + sample.has).toBeLessThanOrEqual(12 * n + 32)
      }
    }
    await refreshWebRuntimeSessionTabsSnapshot(ENV, WT, { acceptCurrentSnapshot: true })
    expect(order()).toEqual(expected)
  }
)

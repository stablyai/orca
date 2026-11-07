import '../../../src/main/runtime/orca-runtime-tests/runtime-test-module-registration.spec'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setRuntimeBrowserCommandsFactory } from '../../../src/main/runtime/browser/installation/runtime-browser-commands-factory'
import { RuntimeBrowserCommands } from '../../../src/main/runtime/browser/commands/browser-commands'
import { withOpenedServeBrowserTab } from '../../../src/main/runtime/serve-browser-tab-layout'
import type { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import { TEST_WORKTREE_ID as WT } from '../../../src/main/runtime/orca-runtime-tests/orca-runtime-test-fixtures.spec'
import { createRuntimeFixture } from './active-tab-publication.test-fixture'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../src/shared/runtime-session-contracts'
import { getDefaultWorkspaceSession } from '../../../src/shared/constants'

const A = 'agent-session:chat-a'
const B = 'agent-session:chat-b'
const list = (runtime: OrcaRuntimeService) => runtime.listMobileSessionTabs(`id:${WT}`)
const createRuntime = () => createRuntimeFixture().runtime
async function publish(runtime: OrcaRuntimeService, id: string, activate = true) {
  await runtime.publishStructuredAgentSessionTab({
    workspaceId: WT,
    sessionId: id.slice('agent-session:'.length),
    agent: id === A ? 'claude' : 'codex',
    activate
  })
}
function accept(runtime: OrcaRuntimeService, frame: RuntimeMobileSessionTabsSnapshot) {
  runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [frame] })
}
function expectSelection(
  snapshot: RuntimeMobileSessionTabsResult | RuntimeMobileSessionTabsSnapshot | undefined,
  id: string | null
) {
  expect(snapshot?.activeTabId).toBe(id)
  expect(snapshot?.activeTabType).toBe(id ? 'agent-session' : null)
  expect(snapshot?.tabs.filter((tab) => tab.isActive).map((tab) => tab.id)).toEqual(id ? [id] : [])
}
afterEach(() => {
  setRuntimeBrowserCommandsFactory(null)
  vi.useRealTimers()
})
describe('legacy host navigation through inventory reconstruction', () => {
  it('activates an existing chat from an admitted legacy snapshot without groups', async () => {
    const runtime = createRuntime()
    await publish(runtime, A)
    await publish(runtime, B, false)
    await list(runtime)
    const before = runtime.mobileSessionTabsByWorktree.get(WT)!
    accept(runtime, {
      ...before,
      publicationEpoch: 'renderer:legacy-explicit',
      snapshotVersion: 20,
      activeGroupId: null,
      tabGroups: undefined
    })
    expect(runtime.mobileSessionTabsByWorktree.get(WT)?.tabGroups).toBeUndefined()

    const seen: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => seen.push(snapshot))
    await publish(runtime, B)

    expectSelection(runtime.mobileSessionTabsByWorktree.get(WT), B)
    const result = await list(runtime)
    expectSelection(result, B)
    expectSelection(seen.at(-1), B)
  })

  it.each([
    { selected: B, saved: A },
    { selected: B, saved: null },
    { selected: null, saved: A }
  ])(
    'retains legacy $selected over saved $saved while reconstructing a split',
    async ({ selected, saved }) => {
      vi.useFakeTimers()
      const { runtime, getSession, setSession } = createRuntimeFixture()
      await publish(runtime, A)
      await publish(runtime, B, false)
      await list(runtime)
      const before = runtime.mobileSessionTabsByWorktree.get(WT)!
      const layout = {
        type: 'split' as const,
        direction: 'vertical' as const,
        first: { type: 'leaf' as const, groupId: 'left' },
        second: { type: 'leaf' as const, groupId: 'right' }
      }
      setSession({
        ...getSession(),
        tabGroups: {
          [WT]: [
            {
              id: 'left',
              worktreeId: WT,
              activeTabId: saved,
              tabOrder: ['serve-tab', A],
              recentTabIds: []
            },
            { id: 'right', worktreeId: WT, activeTabId: B, tabOrder: [B], recentTabIds: [] }
          ]
        },
        activeGroupIdByWorktree: { [WT]: 'left' },
        tabGroupLayouts: { [WT]: layout }
      })
      accept(runtime, {
        ...before,
        publicationEpoch: 'renderer:legacy-split',
        snapshotVersion: 30,
        activeGroupId: null,
        activeTabId: selected,
        activeTabType: selected ? 'agent-session' : null,
        tabGroups: undefined,
        tabGroupLayout: undefined,
        tabs: before.tabs.map((tab) => ({ ...tab, isActive: tab.id === selected }))
      })
      const result = await list(runtime)
      expectSelection(result, selected)
      expect(result.activeGroupId).toBe(selected ? 'right' : 'left')
      const stored = runtime.mobileSessionTabsByWorktree.get(WT)!
      expect(stored.tabGroupLayout).toEqual(layout)
      expect(stored.tabGroups?.map((group) => [group.id, group.tabOrder])).toEqual([
        ['left', ['serve-tab', A]],
        ['right', [B]]
      ])
      await vi.runAllTimersAsync()
      const seen: RuntimeMobileSessionTabsResult[] = []
      runtime.onMobileSessionTabsChanged((snapshot) => seen.push(snapshot))
      expectSelection(await list(runtime), selected)
      await vi.runAllTimersAsync()
      expect(runtime.mobileSessionTabsByWorktree.get(WT)).toBe(stored)
      expect(seen).toEqual([])
    }
  )

  it('publishes an explicit browser switch from a legacy graph to list and live readers', async () => {
    vi.useFakeTimers()
    setRuntimeBrowserCommandsFactory((host) => new RuntimeBrowserCommands(host))
    const { runtime, setSession } = createRuntimeFixture()
    let saved = getDefaultWorkspaceSession()
    for (const pageId of ['page-a', 'page-b']) {
      saved = withOpenedServeBrowserTab('local', saved, {
        worktreeId: WT,
        pageId,
        url: 'https://example.com/',
        title: pageId
      })!
    }
    setSession(saved)
    runtime.setOffscreenBrowserBackend({
      createTab: vi.fn(async () => ({ browserPageId: 'unused' })),
      closeTab: vi.fn(async () => {}),
      ownsTab: () => true
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: External browser operations; runtime selection and publication remain real.
    runtime.setAgentBrowserBridge({
      tabList: () => ({
        tabs: ['page-a', 'page-b'].map((browserPageId, index) => ({
          browserPageId,
          index,
          url: 'https://example.com/',
          title: browserPageId,
          active: index === 0
        }))
      }),
      tabSwitch: vi.fn(async () => ({ switched: 1, browserPageId: 'page-b' })),
      getRegisteredTabs: () =>
        new Map([
          ['page-a', 1],
          ['page-b', 2]
        ])
    } as never)
    const tabs: RuntimeMobileSessionTabsSnapshot['tabs'] = ['page-a', 'page-b'].map((id) => ({
      type: 'browser',
      id,
      browserWorkspaceId: id,
      browserPageId: id,
      title: id,
      url: 'https://example.com/',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      isActive: id === 'page-a'
    }))
    accept(runtime, {
      worktree: WT,
      publicationEpoch: 'renderer:legacy-browser',
      snapshotVersion: 10,
      activeGroupId: null,
      activeTabId: 'page-a',
      activeTabType: 'browser',
      tabs
    })
    expect(runtime.mobileSessionTabsByWorktree.get(WT)?.tabGroups).toBeUndefined()
    const seen: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => seen.push(snapshot))
    await runtime.browserTabSwitch({ worktree: `id:${WT}`, page: 'page-b', focus: true })
    await vi.runAllTimersAsync()
    const result = await list(runtime)
    expect(runtime.mobileSessionTabsByWorktree.get(WT)?.activeTabId).toBe('page-b')
    expect(result.activeTabId).toBe('page-b')
    expect(result.activeTabType).toBe('browser')
    expect(result.tabs.filter((tab) => tab.isActive).map((tab) => tab.id)).toEqual(['page-b'])
    expect(seen.at(-1)?.activeTabId).toBe('page-b')
  })
})

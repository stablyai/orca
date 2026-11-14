import '../../../src/main/runtime/orca-runtime-tests/runtime-test-module-registration.spec'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setRuntimeBrowserCommandsFactory } from '../../../src/main/runtime/browser/installation/runtime-browser-commands-factory'
import { RuntimeBrowserCommands } from '../../../src/main/runtime/browser/commands/browser-commands'
import { withOpenedServeBrowserTab } from '../../../src/main/runtime/browser/headless/serve-browser-tab-layout'
import type { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import { TEST_WORKTREE_ID as WT } from '../../../src/main/runtime/orca-runtime-tests/orca-runtime-test-fixtures.spec'
import { createRuntimeFixture } from './active-tab-publication.test-fixture'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../src/shared/runtime-session-contracts'
import { getDefaultWorkspaceSession } from '../../../src/shared/constants'

const list = (runtime: OrcaRuntimeService) => runtime.listMobileSessionTabs(`id:${WT}`)

function accept(runtime: OrcaRuntimeService, frame: RuntimeMobileSessionTabsSnapshot) {
  runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [frame] })
}

afterEach(() => {
  setRuntimeBrowserCommandsFactory(null)
  vi.useRealTimers()
})
describe('legacy host navigation through inventory reconstruction', () => {
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
      getRemoteTabFaviconUrl: () => null,
      getPageNavigationState: () => null,
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

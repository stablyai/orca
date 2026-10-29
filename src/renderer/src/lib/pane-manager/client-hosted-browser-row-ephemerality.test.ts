/** Client-hosted UI rows own no host page and must never enter persistence/runtime graphs, which would resurrect them as local tabs. Exercise both sinks with paired live-row presence checks so empty results cannot pass vacuously. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import { buildWorkspaceSessionPayload } from '../workspace-session'
import { buildWorkspaceSessionPatch } from '../workspace-session-patch'
import { buildMobileSessionTabSnapshots } from '../../runtime/sync-runtime-graph/mobile-session-snapshots'
import {
  applyClientHostedBrowserRows,
  getClientHostedBrowserRows,
  hydrateClientHostedBrowserRows
} from './client-hosted-browser-row-state'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

const WT = 'wt-1'
const CLIENT_HOSTED_PAGE_ID = 'client-hosted-page-1'

let initialState: AppState
let main: TabsDrawnFromMain | undefined

async function seedLocalBrowserTab(): Promise<string> {
  main = await drawTabsFromMain(useAppStore)
  const workspace = useAppStore.getState().createBrowserTab(WT, 'https://local.test/', {
    title: 'Local page',
    activate: true
  })
  await main.settle()
  return workspace.id
}

function pushClientHostedRow(): void {
  applyClientHostedBrowserRows({
    worktreeId: WT,
    rows: [
      {
        browserPageId: CLIENT_HOSTED_PAGE_ID,
        worktreeId: WT,
        url: 'https://client-hosted.test/',
        title: 'Client hosted page',
        loading: false,
        browserHostClientId: 'host-a',
        hostDeviceName: 'Studio',
        hostAbsent: false
      }
    ]
  })
}

function serialize(value: unknown): string {
  return JSON.stringify(value)
}

beforeEach(() => {
  initialState = useAppStore.getState()
  hydrateClientHostedBrowserRows([])
})

afterEach(() => {
  main?.close()
  main = undefined
  useAppStore.setState(initialState, true)
  hydrateClientHostedBrowserRows([])
})

describe('client-hosted rows and the persisted workspace session', () => {
  it('persists a local browser tab but never a client-hosted row', async () => {
    const localWorkspaceId = await seedLocalBrowserTab()
    pushClientHostedRow()
    // Guard the oracle itself: the row has to be live for its absence downstream to mean anything.
    expect(getClientHostedBrowserRows(WT)).toHaveLength(1)

    const payload = buildWorkspaceSessionPayload(useAppStore.getState())

    expect(serialize(payload)).toContain(localWorkspaceId)
    expect(serialize(payload)).not.toContain(CLIENT_HOSTED_PAGE_ID)
    expect(serialize(payload)).not.toContain('https://client-hosted.test/')
  })

  it('keeps a client-hosted row out of incremental session patches too', async () => {
    const localWorkspaceId = await seedLocalBrowserTab()
    pushClientHostedRow()

    const patch = buildWorkspaceSessionPatch(useAppStore.getState(), [
      'browserTabsByWorktree',
      'browserPagesByWorkspace',
      'activeBrowserTabIdByWorktree',
      'unifiedTabsByWorktree',
      'groupsByWorktree'
    ])

    expect(serialize(patch)).toContain(localWorkspaceId)
    expect(serialize(patch)).not.toContain(CLIENT_HOSTED_PAGE_ID)
  })

  it('leaves the store tab model untouched when a row arrives', async () => {
    await seedLocalBrowserTab()
    const before = {
      browserTabs: useAppStore.getState().browserTabsByWorktree[WT],
      unifiedTabs: useAppStore.getState().unifiedTabsByWorktree[WT],
      browserPages: useAppStore.getState().browserPagesByWorkspace
    }

    pushClientHostedRow()

    expect(useAppStore.getState().browserTabsByWorktree[WT]).toBe(before.browserTabs)
    expect(useAppStore.getState().unifiedTabsByWorktree[WT]).toBe(before.unifiedTabs)
    expect(useAppStore.getState().browserPagesByWorkspace).toBe(before.browserPages)
  })
})

describe('client-hosted rows and the runtime window graph', () => {
  it('publishes a local browser tab to the host graph but never a client-hosted row', async () => {
    const localWorkspaceId = await seedLocalBrowserTab()
    pushClientHostedRow()
    expect(getClientHostedBrowserRows(WT)).toHaveLength(1)

    const snapshots = buildMobileSessionTabSnapshots(useAppStore.getState())

    const published = snapshots.find((snapshot) => snapshot.worktree === WT)
    expect(
      published?.tabs.some(
        (tab) => tab.type === 'browser' && serialize(tab).includes(localWorkspaceId)
      ),
      'the oracle must see a real browser tab, or its blindness would read as absence'
    ).toBe(true)
    expect(serialize(snapshots)).not.toContain(CLIENT_HOSTED_PAGE_ID)
    expect(serialize(snapshots)).not.toContain('https://client-hosted.test/')
  })
})

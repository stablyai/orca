/**
 * The invariant that makes these rows safe: they are ephemeral.
 *
 * A client-hosted row describes a page this desktop does not render. If one ever reached the
 * persisted workspace session or the runtime window graph, the host would round-trip it back as a
 * host-owned local tab — resurrecting a dead page as a real one after restart. Both sinks are
 * driven for real below, and every absence is paired with a presence check through the same
 * oracle so an empty result can never pass for a proof.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import { buildWorkspaceSessionPayload } from '../workspace-session'
import { buildWorkspaceSessionPatch } from '../workspace-session-patch'
import { buildMobileSessionTabSnapshots } from '../../runtime/sync-runtime-graph'
import {
  applyClientHostedBrowserRows,
  getClientHostedBrowserRows,
  hydrateClientHostedBrowserRows
} from './client-hosted-browser-row-state'

const WT = 'wt-1'
const CLIENT_HOSTED_PAGE_ID = 'client-hosted-page-1'

let initialState: AppState

function seedLocalBrowserTab(): string {
  const workspace = useAppStore.getState().createBrowserTab(WT, 'https://local.test/', {
    title: 'Local page',
    activate: true
  })
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
  useAppStore.setState(initialState, true)
  hydrateClientHostedBrowserRows([])
})

describe('client-hosted rows and the persisted workspace session', () => {
  it('persists a local browser tab but never a client-hosted row', () => {
    const localWorkspaceId = seedLocalBrowserTab()
    pushClientHostedRow()
    // Guard the oracle itself: the row has to be live for its absence downstream to mean anything.
    expect(getClientHostedBrowserRows(WT)).toHaveLength(1)

    const payload = buildWorkspaceSessionPayload(useAppStore.getState())

    expect(serialize(payload)).toContain(localWorkspaceId)
    expect(serialize(payload)).not.toContain(CLIENT_HOSTED_PAGE_ID)
    expect(serialize(payload)).not.toContain('https://client-hosted.test/')
  })

  it('keeps a client-hosted row out of incremental session patches too', () => {
    const localWorkspaceId = seedLocalBrowserTab()
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

  it('leaves the store tab model untouched when a row arrives', () => {
    seedLocalBrowserTab()
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
  it('publishes a local browser tab to the host graph but never a client-hosted row', () => {
    const localWorkspaceId = seedLocalBrowserTab()
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SnapshotModule from '../runtime/web-runtime-session-snapshot'
import { useAppStore } from '../store'
import { openWorkspaceBrowserTab } from './workspace-browser-tab-open'
import { resetWebSessionBrowserPlacementsForTests } from '../runtime/web-session-browser-placement'
import { resetWebSessionTabsSyncTestState, WT } from '../runtime/web-session-tabs-sync-test-harness'
import {
  G1,
  G2,
  HOST,
  groupOrder,
  hostPages,
  installRuntimeTransport,
  pendingCreates,
  publishHostSnapshot,
  resetHostPages,
  runtimeStatusesFor,
  seedPairedWorktree,
  wrapperForRemotePage
} from '../runtime/web-runtime-browser-creation-placement-test-rig'
import { makeRepo, makeWorktree } from '../components/worktree-jump-palette-test-fixtures'

vi.mock('../runtime/web-runtime-session-snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof SnapshotModule>()),
  refreshWebRuntimeSessionTabsSnapshot: vi.fn(async () => publishHostSnapshot())
}))

const initialState = useAppStore.getInitialState()

describe('workspace URL tab placement', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    resetWebSessionTabsSyncTestState()
    resetWebSessionBrowserPlacementsForTests()
    resetHostPages()
    seedPairedWorktree()
    installRuntimeTransport()
    useAppStore.setState({
      repos: [{ ...makeRepo(), id: 'repo', executionHostId: HOST }],
      worktreesByRepo: {
        repo: [makeWorktree(WT, 'Workspace', { repoId: 'repo', hostId: HOST })]
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetWebSessionTabsSyncTestState()
    resetWebSessionBrowserPlacementsForTests()
    useAppStore.setState(initialState, true)
  })

  it.each([true, false])(
    'keeps the invoking split when a host snapshot precedes the create response (known page ID: %s)',
    async (knownPageId) => {
      useAppStore.setState({
        runtimeStatusByEnvironmentId: runtimeStatusesFor([
          'browser.screencast.v1',
          ...(knownPageId ? ['browser.tab-create-known-id.v1'] : [])
        ])
      })
      const creating = openWorkspaceBrowserTab({
        workspaceId: WT,
        targetGroupId: G1,
        url: 'https://example.com/',
        intent: { kind: 'url' },
        placementPreference: 'server'
      })
      expect(pendingCreates).toHaveLength(1)
      expect(groupOrder(G1)).toHaveLength(3)
      useAppStore.getState().focusGroup(WT, G2)
      const pageId = pendingCreates[0].params.page ?? 'host-minted-page'
      hostPages.push(pageId)
      publishHostSnapshot()
      hostPages.pop()
      pendingCreates[0].resolve(pageId)
      await creating

      expect(wrapperForRemotePage(pageId)?.groupId).toBe(G1)
      expect(useAppStore.getState().activeGroupIdByWorktree[WT]).toBe(G2)
      publishHostSnapshot()
      expect(wrapperForRemotePage(pageId)?.groupId).toBe(G1)
    }
  )
})

import type * as BrowserFocusModule from '@/components/browser-pane/host-guest/browser-focus'
import type { BrowserSessionProfile } from '../../../shared/browser-workspace-types'
import { SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY } from '../../../shared/session-tabs-runtime-capabilities'
import {
  BROWSER_SCREENCAST_RUNTIME_CAPABILITY,
  BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import { canOfferHttpLinkGroupAction } from '../lib/http-link-in-group-availability'
import { createWebRuntimeSessionBrowserTab } from './web-runtime-browser-creation'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SnapshotModule from './web-runtime-session-snapshot'
import { useAppStore } from '../store'
import { openWorkspaceBrowserTabForLink } from '../lib/workspace-browser-tab-open'
import { captureLinkOpenIntent } from '../lib/link-open-intent'
import { beginLinkOpenRequest } from '../lib/link-open-request'
import { makeWorktree, TEST_REPO } from '../store/slices/worktrees-slice-test-fixtures'
import { resetWebSessionBrowserPlacementsForTests } from './web-session-browser-placement'
import { resetWebSessionTabsSyncTestState, ENV, WT } from './web-session-tabs-sync-test-harness'
import {
  G1,
  G2,
  HOST,
  SOURCE,
  pendingCreates,
  publishHostSnapshot,
  resetHostPages,
  seedPairedWorktree,
  installRuntimeTransport,
  runtimeStatusesFor,
  wrapperForRemotePage
} from './web-runtime-browser-creation-placement-test-rig'
import { captureWebSessionIntentOwner } from './web-runtime-session-environment'
import { peekWebSessionFocusIntent } from './web-session-focus-intent'

vi.mock('@/components/browser-pane/host-guest/browser-focus', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserFocusModule>()),
  requestBrowserFocus: vi.fn()
}))
vi.mock('./web-runtime-session-snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof SnapshotModule>()),
  refreshWebRuntimeSessionTabsSnapshot: vi.fn(async () => publishHostSnapshot())
}))

beforeEach(() => {
  resetWebSessionTabsSyncTestState()
  resetWebSessionBrowserPlacementsForTests()
  resetHostPages()
  seedPairedWorktree()
  useAppStore.setState({
    repos: [{ ...TEST_REPO, id: 'repo', executionHostId: HOST }],
    worktreesByRepo: {
      repo: [
        makeWorktree({
          id: WT,
          repoId: 'repo',
          path: '/worktree',
          hostId: HOST,
          runtimeOwnerEnvironmentId: ENV
        })
      ]
    }
  })
  installRuntimeTransport()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function open(explicit = false) {
  return openWorkspaceBrowserTabForLink({
    workspaceId: WT,
    url: 'https://example.com/link',
    intent: { kind: 'url' },
    expectedRuntimeEnvironmentId: ENV,
    placementPreference: 'server',
    selectWorktree: false,
    linkContext: {
      linkIntent: captureLinkOpenIntent(useAppStore.getState(), WT, SOURCE.unifiedTabId, {
        explicitSourceGroup: explicit
      }),
      isCurrentRequest: beginLinkOpenRequest()
    }
  })
}

describe('runtime link opens through staging and materialization', () => {
  it('stages in the adjacent group and returns the reconciled host page identity', async () => {
    const creating = open()
    expect(pendingCreates).toHaveLength(1)
    const provisional = pendingCreates[0]!.params.page
    expect(pendingCreates[0]!.params.targetGroupId).toBe(G2)
    expect(wrapperForRemotePage(provisional!)?.groupId).toBe(G2)
    pendingCreates[0]!.resolve('actual-host-page')
    const outcome = await creating
    expect(outcome).toMatchObject({
      status: 'opened',
      result: { groupId: G2, executionHostId: HOST, worktreeId: WT }
    })
    if (outcome.status !== 'opened') {
      throw new Error('Expected open')
    }
    expect(outcome.result.unifiedTabId).toBe(wrapperForRemotePage('actual-host-page')?.id)
    expect(
      useAppStore.getState().remoteBrowserPageHandlesByPageId[outcome.result.browserPageId]
    ).toMatchObject({ remotePageId: 'actual-host-page', environmentId: ENV })
  })

  it('refuses new explicit creation before staging when strict peer placement is unproven', async () => {
    const before = useAppStore.getState().unifiedTabsByWorktree
    expect(await open(true)).toEqual({ status: 'unsupported' })
    expect(pendingCreates).toHaveLength(0)
    expect(useAppStore.getState().unifiedTabsByWorktree).toBe(before)
  })

  it('offers explicit runtime reuse only when a matching pinned page proves the route and session', async () => {
    const state = useAppStore.getState()
    const profile: BrowserSessionProfile = {
      id: 'default',
      scope: 'default',
      partition: 'persist:remote-default',
      label: 'Default',
      source: null
    }
    useAppStore.setState({
      browserSessionProfilesByHostId: { [HOST]: [profile] },
      remoteBrowserPageHandlesByPageId: {
        ...state.remoteBrowserPageHandlesByPageId,
        [SOURCE.pageId]: {
          environmentId: ENV,
          remotePageId: SOURCE.pageId,
          browserProfileId: 'default'
        }
      },
      browserTabsByWorktree: {
        [WT]: state.browserTabsByWorktree[WT]!.map((workspace) => ({
          ...workspace,
          sessionProfileId: null,
          sessionPartition: 'persist:remote-default'
        }))
      },
      browserPagesByWorkspace: {
        ...state.browserPagesByWorkspace,
        [SOURCE.workspaceId]: state.browserPagesByWorkspace[SOURCE.workspaceId]!.map((page) => ({
          ...page,
          url: 'https://example.com/link'
        }))
      }
    })
    expect(
      canOfferHttpLinkGroupAction(useAppStore.getState(), {
        workspaceId: WT,
        sourceTabId: SOURCE.unifiedTabId,
        url: 'https://example.com/link',
        sourceOwner: { kind: 'runtime', runtimeEnvironmentId: ENV }
      })
    ).toBe(true)
    expect(await open(true)).toMatchObject({
      status: 'opened',
      result: { browserWorkspaceId: SOURCE.workspaceId, browserPageId: SOURCE.pageId, groupId: G1 }
    })
    expect(pendingCreates).toHaveLength(0)
  })

  it('keeps new explicit creation unavailable even if a session split capability is advertised', async () => {
    useAppStore.setState({
      runtimeStatusByEnvironmentId: runtimeStatusesFor([
        BROWSER_SCREENCAST_RUNTIME_CAPABILITY,
        BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY,
        SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY
      ])
    })
    expect(
      canOfferHttpLinkGroupAction(useAppStore.getState(), {
        workspaceId: WT,
        sourceTabId: SOURCE.unifiedTabId,
        url: 'https://example.com/link',
        sourceOwner: { kind: 'runtime', runtimeEnvironmentId: ENV }
      })
    ).toBe(false)
    expect(await open(true)).toEqual({ status: 'unsupported' })
    expect(pendingCreates).toHaveLength(0)
  })

  it('reconciles a page from an older peer that cannot accept a provisional ID', async () => {
    useAppStore.setState({
      runtimeStatusByEnvironmentId: runtimeStatusesFor([BROWSER_SCREENCAST_RUNTIME_CAPABILITY])
    })
    const creating = open()
    expect(pendingCreates[0]!.params.page).toBeUndefined()
    pendingCreates[0]!.resolve('legacy-page')
    const outcome = await creating
    expect(outcome).toMatchObject({ status: 'opened', result: { groupId: G2 } })
    if (outcome.status !== 'opened') {
      throw new Error('Expected open')
    }
    expect(
      useAppStore.getState().remoteBrowserPageHandlesByPageId[outcome.result.browserPageId]
        ?.remotePageId
    ).toBe('legacy-page')
  })

  it('a delivery callback failure cannot unwind a page that already materialized', async () => {
    const call = installRuntimeTransport()
    const creating = createWebRuntimeSessionBrowserTab({
      worktreeId: WT,
      environmentId: ENV,
      url: 'https://example.com/link',
      placementPreference: 'server',
      selectWorktree: false,
      clientTargetGroupId: G2,
      onMaterialized: () => {
        throw new Error('Delivery failed')
      }
    })
    pendingCreates[0]!.resolve('delivered-page')
    await expect(creating).rejects.toThrow('Delivery failed')
    expect(wrapperForRemotePage('delivered-page')).toBeDefined()
    expect(call.mock.calls.some(([request]) => request.method === 'browser.tabClose')).toBe(false)
  })

  it('a newer link clears pending focus intent and suppresses stale success without claiming cancellation', async () => {
    const creating = open()
    const owner = captureWebSessionIntentOwner(ENV)
    expect(peekWebSessionFocusIntent(owner, WT)).not.toBeNull()
    beginLinkOpenRequest()
    expect(peekWebSessionFocusIntent(owner, WT)).toBeNull()
    pendingCreates[0]!.resolve('superseded-host-page')
    expect(await creating).toEqual({ status: 'superseded' })
    expect(wrapperForRemotePage('superseded-host-page')).toBeDefined()
  })

  it('reports the current group after the user moves the staged tab', async () => {
    const creating = open()
    const provisional = pendingCreates[0]!.params.page!
    const staged = wrapperForRemotePage(provisional)!
    useAppStore.getState().moveUnifiedTabToGroup(staged.id, G1)
    pendingCreates[0]!.resolve()
    expect(await creating).toMatchObject({ status: 'opened', result: { groupId: G1 } })
  })
})

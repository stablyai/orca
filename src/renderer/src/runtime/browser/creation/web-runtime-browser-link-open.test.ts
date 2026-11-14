import { requestBrowserFocus } from '@/components/browser-pane/host-guest/browser-focus'
import type * as BrowserFocusModule from '@/components/browser-pane/host-guest/browser-focus'
import '../../../store/testing/app-store-test-fixture'
import { getDefaultSettings } from '../../../../../shared/constants'
import '../../../../../shared/session-tabs-runtime-capabilities'
import '../../../../../shared/protocol-version'
import '../../../lib/browser/navigation/http-link-in-group-availability'
import { createWebRuntimeSessionBrowserTab } from './web-runtime-browser-creation'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../../store/index'
import * as workspaceBrowserTabOpen from '../../../lib/browser/workspace/workspace-browser-tab-open'
import { openWorkspaceBrowserTabForLink } from '../../../lib/browser/workspace/workspace-browser-tab-open'
import { openHttpLink } from '../../../lib/browser/navigation/http-link-routing'
import { captureLinkOpenIntent } from '../../../lib/links/placement/link-open-intent'
import { beginLinkOpenRequest } from '../../../lib/links/link-open-request'
import { makeWorktree } from '../../../store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '../../../store/repos/repo.test-fixture'
import { resetWebSessionBrowserPlacementsForTests } from '../placement/web-session-browser-placement'
import {
  resetWebSessionTabsSyncTestState,
  ENV,
  WT
} from '../../web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'
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
  wrapperForRemotePage
} from './testing/web-runtime-browser-creation-placement-test-rig'
import { captureWebSessionIntentOwner } from '../../web-session-tabs-sync/identity/web-runtime-session-environment'
import { peekWebSessionFocusIntent } from '../../web-session-tabs-sync/navigation/web-session-focus-intent'
import type * as SnapshotModule from '../../web-session-tabs-sync/inventory/web-runtime-session-snapshot'

vi.mock('@/components/browser-pane/host-guest/browser-focus', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserFocusModule>()),
  requestBrowserFocus: vi.fn()
}))
vi.mock(
  '../../web-session-tabs-sync/inventory/web-runtime-session-snapshot',
  async (importOriginal) => ({
    ...(await importOriginal<typeof SnapshotModule>()),
    refreshWebRuntimeSessionTabsSnapshot: vi.fn(async () => publishHostSnapshot())
  })
)

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
  vi.mocked(requestBrowserFocus).mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
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
  it('does not request browser focus after a routed link completes with another pane focused', async () => {
    useAppStore.setState({
      settings: { ...getDefaultSettings('/home/test'), openLinksInApp: true }
    })
    const opening = vi.spyOn(workspaceBrowserTabOpen, 'openWorkspaceBrowserTabForLink')
    openHttpLink('https://example.com/link', {
      worktreeId: WT,
      allowRemoteInApp: true,
      sourceOwner: { kind: 'runtime', runtimeEnvironmentId: ENV },
      linkContext: {
        linkIntent: captureLinkOpenIntent(useAppStore.getState(), WT, SOURCE.unifiedTabId),
        isCurrentRequest: beginLinkOpenRequest()
      }
    })
    await vi.waitFor(() => expect(pendingCreates).toHaveLength(1))
    const owner = captureWebSessionIntentOwner(ENV)
    expect(peekWebSessionFocusIntent(owner, WT)).not.toBeNull()
    useAppStore.getState().focusGroup(WT, G1)
    expect(peekWebSessionFocusIntent(owner, WT)).toBeNull()
    vi.mocked(requestBrowserFocus).mockClear()

    pendingCreates[0]!.resolve('routed-host-page')
    expect(await opening.mock.results[0]!.value).toMatchObject({ status: 'opened' })
    await Promise.resolve()
    await Promise.resolve()

    const browser = wrapperForRemotePage('routed-host-page')!
    expect(useAppStore.getState().activeGroupIdByWorktree[WT]).toBe(G1)
    expect(
      useAppStore.getState().groupsByWorktree[WT]?.find((group) => group.id === G2)?.activeTabId
    ).toBe(browser.id)
    expect(requestBrowserFocus).not.toHaveBeenCalled()
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
})

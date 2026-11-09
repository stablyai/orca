import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as BrowserFocusModule from '@/components/browser-pane/host-guest/browser-focus'
import type { RuntimeMobileSessionBrowserTab } from '../../../../../shared/runtime-mobile-session-tab-contracts'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { getDefaultSettings } from '../../../../../shared/constants'
import { useAppStore } from '../../../store/index'
import { openWorkspaceBrowserTabForLink } from '../../../lib/browser/workspace/workspace-browser-tab-open'
import { selectBrowserLinkDestination } from '../../../lib/browser/navigation/browser-link-destination'
import { workspaceBrowserLinkDestination } from '../../../lib/browser/workspace/workspace-browser-link-open'
import { captureLinkOpenIntent } from '../../../lib/link-open-intent'
import { makeWorktree } from '../../../store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '../../../store/repos/repo.test-fixture'
import { applyWebSessionTabsSnapshot } from '../../web-session-tabs-sync/snapshot-api'
import type * as SnapshotModule from '../../web-session-tabs-sync/inventory/web-runtime-session-snapshot'
import {
  resetWebSessionTabsSyncTestState,
  ENV,
  WT,
  NOW,
  makeSnapshot
} from '../../web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'
import {
  seedPairedWorktree,
  installRuntimeTransport,
  pendingCreates,
  resetHostPages,
  publishHostSnapshot,
  wrapperForRemotePage,
  HOST,
  SOURCE,
  AFTER,
  OTHER
} from './testing/web-runtime-browser-creation-placement-test-rig'

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

let snapshotVersion = 1
const URL_TO_OPEN = 'https://example.com/link'

beforeEach(() => {
  resetWebSessionTabsSyncTestState()
  resetHostPages()
  seedPairedWorktree()
  snapshotVersion = 1
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
    },
    browserSessionHostIdOverride: 'local',
    settings: getDefaultSettings('/home/test'),
    browserSessionProfilesByHostId: {
      [HOST]: [
        {
          id: 'default',
          scope: 'default' as const,
          partition: 'persist:remote-default',
          label: 'Default',
          source: null
        }
      ]
    }
  })
  installRuntimeTransport()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function setDefaultProfiles(
  browserDefaultProfileIdByHostId: Partial<Record<ExecutionHostId, string>>
): void {
  const settings = useAppStore.getState().settings!
  useAppStore.setState({ settings: { ...settings, browserDefaultProfileIdByHostId } })
}

function open(explicit = false) {
  return openWorkspaceBrowserTabForLink({
    workspaceId: WT,
    url: URL_TO_OPEN,
    intent: { kind: 'url' },
    expectedRuntimeEnvironmentId: ENV,
    placementPreference: 'server',
    selectWorktree: false,
    linkContext: {
      linkIntent: captureLinkOpenIntent(useAppStore.getState(), WT, OTHER.unifiedTabId, {
        explicitSourceGroup: explicit
      })
    }
  })
}

function publishProfileSnapshot(profileId: string | undefined): void {
  const tabs: RuntimeMobileSessionBrowserTab[] = [SOURCE, AFTER, OTHER].map((row) => ({
    type: 'browser',
    id: `host-${row.unifiedTabId}`,
    browserPageId: row.pageId,
    browserWorkspaceId: row.workspaceId,
    ...(row === OTHER && profileId ? { browserProfileId: profileId } : {}),
    title: 'Example',
    url: row === OTHER ? URL_TO_OPEN : 'https://example.com/',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isActive: false
  }))
  const snapshot = makeSnapshot(tabs, {
    snapshotVersion: ++snapshotVersion,
    activeTabType: 'browser',
    activeTabId: null
  })
  useAppStore.setState((state) =>
    applyWebSessionTabsSnapshot(state, snapshot, ENV, NOW + snapshotVersion)
  )
}

function selectDestination() {
  const state = useAppStore.getState()
  return selectBrowserLinkDestination(
    state,
    workspaceBrowserLinkDestination(
      { workspaceId: WT, url: URL_TO_OPEN, intent: { kind: 'url' } },
      HOST,
      ENV,
      HOST
    ),
    captureLinkOpenIntent(state, WT, OTHER.unifiedTabId, { explicitSourceGroup: true })
  )
}

it.each([
  { profileId: null, explicit: false },
  { profileId: 'remote-profile', explicit: false },
  { profileId: null, explicit: true },
  { profileId: 'remote-profile', explicit: true }
])(
  'opens with the host-confirmed profile ($profileId, explicit target: $explicit)',
  async ({ profileId, explicit }) => {
    setDefaultProfiles(profileId ? { [HOST]: profileId } : {})
    publishProfileSnapshot(profileId ?? 'default')
    const creating = open(explicit)
    pendingCreates[0]?.resolve('new-host-page')
    const outcome = await creating
    if (explicit) {
      expect(outcome).toMatchObject({
        status: 'opened',
        result: { browserPageId: OTHER.pageId }
      })
      return
    }
    expect(outcome.status).toBe('opened')
    if (outcome.status !== 'opened') {
      throw new Error('Expected opened link')
    }
    expect(outcome.result.browserPageId).not.toBe(OTHER.pageId)
    expect(
      useAppStore.getState().remoteBrowserPageHandlesByPageId[outcome.result.browserPageId]
    ).toMatchObject({ remotePageId: 'new-host-page', environmentId: ENV })
  }
)

it('updates and clears published profile evidence even when page content stays identical', () => {
  publishProfileSnapshot('default')
  expect(selectDestination()).toMatchObject({ match: { browserPageId: OTHER.pageId } })
  const handles = useAppStore.getState().remoteBrowserPageHandlesByPageId
  publishProfileSnapshot('default')
  expect(useAppStore.getState().remoteBrowserPageHandlesByPageId).toBe(handles)
  publishProfileSnapshot('other-profile')
  expect(selectDestination()).toMatchObject({ match: null })
  publishProfileSnapshot('default')
  expect(selectDestination()).toMatchObject({ match: { browserPageId: OTHER.pageId } })
  publishProfileSnapshot(undefined)
  expect(selectDestination()).toMatchObject({ match: null })
})

it.each(['unchanged', 'different-host', 'different-runtime'] as const)(
  'validates the captured SSH owner after foreground runtime selection (%s)',
  async (ownerChange) => {
    const sshHost = 'ssh:ssh-target'
    useAppStore.setState((state) => ({
      activeWorkspaceExecutionHostId: sshHost,
      repos: state.repos.map((repo) => ({ ...repo, executionHostId: sshHost })),
      worktreesByRepo: {
        repo: state.worktreesByRepo.repo!.map((worktree) => ({ ...worktree, hostId: sshHost }))
      },
      unifiedTabsByWorktree: {
        [WT]: state.unifiedTabsByWorktree[WT]!.map((tab) => ({
          ...tab,
          executionHostId: sshHost
        }))
      }
    }))
    vi.spyOn(useAppStore.getState(), 'refreshGitHubForWorktreeIfStale').mockImplementation(
      () => undefined
    )
    const creating = openWorkspaceBrowserTabForLink({
      workspaceId: WT,
      url: URL_TO_OPEN,
      intent: { kind: 'url' },
      expectedRuntimeEnvironmentId: ENV,
      placementPreference: 'server',
      linkContext: {
        linkIntent: captureLinkOpenIntent(useAppStore.getState(), WT, SOURCE.unifiedTabId)
      }
    })
    expect(pendingCreates).toHaveLength(1)
    expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe(HOST)
    if (ownerChange === 'different-host') {
      useAppStore.setState((state) => ({
        activeWorkspaceExecutionHostId: 'ssh:other-target',
        worktreesByRepo: {
          repo: [
            ...state.worktreesByRepo.repo!,
            ...state.worktreesByRepo.repo!.map((worktree) => ({
              ...worktree,
              hostId: 'ssh:other-target' as const
            }))
          ]
        }
      }))
    } else if (ownerChange === 'different-runtime') {
      useAppStore.setState((state) => ({
        activeWorkspaceExecutionHostId: sshHost,
        worktreesByRepo: {
          repo: state.worktreesByRepo.repo!.map((worktree) => ({
            ...worktree,
            runtimeOwnerEnvironmentId: 'other-environment'
          }))
        }
      }))
    }
    const remotePageId = `foreground-ssh-${ownerChange}`
    pendingCreates[0]!.resolve(remotePageId)
    const outcome = await creating
    expect(wrapperForRemotePage(remotePageId)).toBeDefined()
    expect(outcome).toMatchObject({
      status: ownerChange === 'unchanged' ? 'opened' : 'refused'
    })
    if (outcome.status === 'opened') {
      expect(outcome.result).toMatchObject({ worktreeId: WT, executionHostId: sshHost })
    }
  }
)

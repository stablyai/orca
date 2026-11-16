import '../../../store/testing/app-store-test-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../../../store/index'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/workspace/identity/floating-workspace-id'
import '../../../../../shared/remote-runtime/protocol/session-tabs-runtime-capabilities'
import '../../../../../shared/remote-runtime/protocol/protocol-version'
import { openWorkspaceBrowserTabForLink } from '../../../lib/browser/workspace/workspace-browser-tab-open'
import { makeWorktree } from '../../../store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '../../../store/repos/repo.test-fixture'
import { resetWebSessionBrowserPlacementsForTests } from '../placement/web-session-browser-placement'
import {
  resetWebSessionTabsSyncTestState,
  ENV,
  WT
} from '../../web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'
import {
  HOST,
  pendingCreates,
  publishHostSnapshot,
  resetHostPages,
  seedPairedWorktree,
  installRuntimeTransport
} from './testing/web-runtime-browser-creation-placement-test-rig'
import type * as SnapshotModule from '../../web-session-tabs-sync/inventory/web-runtime-session-snapshot'

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
    },
    settings: {
      ...getDefaultSettings('/home/test'),
      browserDefaultProfileIdByHostId: { [HOST]: 'work-profile' },
      floatingTerminalEnabled: true
    },
    floatingWorkspacePanelOpen: true
  })
  installRuntimeTransport()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('sends the source host profile when creating a browser placed in floating', async () => {
  const opening = openWorkspaceBrowserTabForLink({
    workspaceId: WT,
    placementWorkspaceId: FLOATING_TERMINAL_WORKTREE_ID,
    url: 'https://example.com/link',
    intent: { kind: 'url' },
    expectedRuntimeEnvironmentId: ENV,
    placementPreference: 'server',
    focusOnCreate: false,
    linkContext: { linkIntent: null }
  })
  const sentProfileId = pendingCreates[0]!.params.profileId
  pendingCreates[0]!.resolve()
  await expect(opening).resolves.toMatchObject({ status: 'opened' })
  expect(sentProfileId).toBe('work-profile')
})

import '../../../store/testing/app-store-test-fixture'
import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '../../../store/index'
import { markHydratedBrowserPageHandles } from '../../../store/slices/browser/hosts/browser-initialization-presentation-ownership'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/workspace/identity/floating-workspace-id'
import { applyWebSessionTabsSnapshot } from '../../web-session-tabs-sync/snapshots/snapshot-api'
import {
  ENV,
  NOW,
  WT,
  makeSnapshot
} from '../../web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'
import {
  SOURCE,
  seedPairedWorktree
} from './testing/web-runtime-browser-creation-placement-test-rig'

afterEach(() => {
  const initial = useAppStore.getInitialState()
  useAppStore.setState(
    {
      ...initial,
      remoteBrowserPageHandlesByPageId: markHydratedBrowserPageHandles({
        ...initial.remoteBrowserPageHandlesByPageId
      })
    },
    true
  )
})

it('updates host pin state without moving a browser out of floating', () => {
  seedPairedWorktree()
  const state = useAppStore.getState()
  const source = state.unifiedTabsByWorktree[WT]![0]!
  useAppStore.setState({
    unifiedTabsByWorktree: {
      [WT]: state.unifiedTabsByWorktree[WT]!.slice(1),
      [FLOATING_TERMINAL_WORKTREE_ID]: [
        { ...source, worktreeId: FLOATING_TERMINAL_WORKTREE_ID, groupId: 'floating-group' }
      ]
    }
  })
  for (const [isPinned, expectedPinned] of [
    [true, true],
    [undefined, true],
    [false, false]
  ] as const) {
    const snapshot = makeSnapshot([
      {
        type: 'browser',
        id: 'host-source',
        title: 'Example',
        browserWorkspaceId: SOURCE.workspaceId,
        browserPageId: SOURCE.pageId,
        url: 'https://example.com/',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        isActive: false,
        ...(isPinned !== undefined ? { isPinned } : {})
      }
    ])
    useAppStore.setState((current) => applyWebSessionTabsSnapshot(current, snapshot, ENV, NOW))
    expect(
      useAppStore.getState().unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
    ).toMatchObject([
      {
        id: 'source-tab',
        entityId: 'source-workspace',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        groupId: 'floating-group',
        isPinned: expectedPinned
      }
    ])
  }
})

// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { PtyFencedTerminationRequest } from '../../../../shared/pty-fenced-termination'
import { mergeWorkspaceSessionsWithHostShadow } from '@/lib/workspace-session-host-contention'
import { buildHostIdByWorktreeId } from '@/lib/workspace-session-host-persistence'
import { createTestStore } from '@/store/slices/store-test-helpers'
import {
  makeFolderWorkspace,
  makeRepo,
  makeTerminalTab,
  makeWorktree
} from '../worktree-jump-palette-test-fixtures'
import { makeProjectGroup } from '../sidebar/folder-workspace-composer-submit-fixtures'
import { buildResourcePtyRows } from './resource-pty-view-model'
import { selectLocalResourceSessionTabs } from './resource-session-bindings'
import { useResourcePtyActions } from './use-resource-pty-actions'
import { useResourceSessionInventory } from './use-resource-session-inventory'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it.each(['worktree', 'folder'] as const)(
  'keeps a new local %s terminal navigable and endable after removing its runtime twin',
  async (kind) => {
    vi.useFakeTimers()
    const kill = vi.fn<(request: PtyFencedTerminationRequest) => Promise<{ outcome: 'ended' }>>()
    kill.mockResolvedValue({ outcome: 'ended' })
    vi.stubGlobal('api', {
      pty: {
        killFenced: kill,
        listSessions: vi.fn().mockResolvedValue([]),
        onSpawned: () => () => {},
        onExit: () => () => {}
      }
    })
    const store = createTestStore()
    const workspaceId = kind === 'worktree' ? 'repo-1::/work/orca' : 'folder:folder-1'
    const runtimeHost = 'runtime:removed' as const
    const localFolder = makeFolderWorkspace({ executionHostId: 'local' })
    store.setState({
      repos: [
        { ...makeRepo(), executionHostId: 'local' },
        { ...makeRepo(), executionHostId: runtimeHost }
      ],
      worktreesByRepo:
        kind === 'worktree'
          ? {
              'repo-1': [
                makeWorktree(workspaceId, 'Local', { hostId: 'local' }),
                makeWorktree(workspaceId, 'Remote', { hostId: runtimeHost })
              ]
            }
          : {},
      projectGroups: [
        { ...makeProjectGroup(), executionHostId: 'local' },
        { ...makeProjectGroup(), executionHostId: runtimeHost }
      ],
      folderWorkspaces:
        kind === 'folder' ? [localFolder, { ...localFolder, executionHostId: runtimeHost }] : []
    })
    const restored = mergeWorkspaceSessionsWithHostShadow({
      [runtimeHost]: {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: { [workspaceId]: [makeTerminalTab('remote-tab', workspaceId, 'Remote')] }
      }
    })
    store.getState().hydrateWorkspaceSession(restored.session, {
      runtimeHostIdByWorkspaceSessionKey: { [workspaceId]: runtimeHost },
      contestedPrimaryHostBySessionKey: restored.primaryHostBySessionKey
    })
    expect(selectLocalResourceSessionTabs(store.getState())).toEqual({})

    store.getState().purgeStaleRuntimeHostState(['removed'])
    const leafId = '11111111-1111-4111-8111-111111111111'
    const tab = store.getState().createTab(workspaceId, undefined, undefined, {
      initialPtyId: 'local-pty',
      initialLeafId: leafId,
      recordInteraction: false
    })
    const state = store.getState()
    expect(state.contestedPrimaryHostBySessionKey[workspaceId]).toBe(runtimeHost)
    expect(buildHostIdByWorktreeId(state)(workspaceId)).toBe('local')

    const rows = buildResourcePtyRows({
      sessions: [
        {
          id: 'local-pty',
          incarnationId: 'current',
          fencedTermination: true,
          agentOwnership: 'absent',
          worktreeId: workspaceId,
          cwd: '/work/orca',
          title: 'Local'
        }
      ],
      bindings: {
        ...state,
        workspaceSessionHostIdByKey: state.contestedPrimaryHostBySessionKey,
        workspaceSessionReady: true
      },
      repos: state.repos,
      worktrees: [
        ...Object.values(state.worktreesByRepo).flat(),
        ...state.folderWorkspaces.map(folderWorkspaceToWorktree)
      ],
      projectGroups: state.projectGroups,
      runtimePaneTitlesByTabId: state.runtimePaneTitlesByTabId
    })
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row).toMatchObject({
      binding: 'bound',
      tabId: tab.id,
      workspaceId,
      paneKey: makePaneKey(tab.id, leafId)
    })
    expect(selectLocalResourceSessionTabs(state)[workspaceId]).toContainEqual(tab)

    const { result } = renderHook(() =>
      useResourcePtyActions(useResourceSessionInventory(true, false, true))
    )
    act(() => result.current.confirm(row))
    await act(async () => result.current.endConfirmed())
    expect(kill).toHaveBeenCalledWith({
      id: 'local-pty',
      expectedIncarnationId: 'current',
      requireNoAgentOwner: true,
      requireUnattached: false
    })
  }
)

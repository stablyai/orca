import { useAppStore } from '@/store'
import { createTabsSliceMockApi } from '@/store/slices/tabs-slice-test-harness'
import type { ExecutionHostId } from '../../../../shared/execution-host'

const initial = useAppStore.getState()

export function resetPanePresentation() {
  const domWindow = window
  const api = createTabsSliceMockApi()
  Object.assign(api, {
    preflight: { detectAgents: async () => [], detectRemoteAgents: async () => [] }
  })
  globalThis.window = domWindow
  Object.assign(window, {
    api,
    orcaWorkspaceViews: undefined,
    orcaWorkspaceWindowNative: undefined
  })
  useAppStore.setState(initial, true)
  useAppStore.setState({ persistedUIReady: true, hydrationSucceeded: true, activeView: 'terminal' })
}

export function addPaneProject(id: string, name: string, host: ExecutionHostId = 'local') {
  const state = useAppStore.getState()
  useAppStore.setState({
    repos: [
      ...state.repos,
      { id, path: `/${id}`, displayName: name, executionHostId: host } as never
    ],
    worktreesByRepo: {
      ...state.worktreesByRepo,
      [id]: [
        {
          id: `${id}-workspace`,
          repoId: id,
          displayName: `${id} branch`,
          path: `/${id}/branch`,
          hostId: host
        } as never
      ]
    }
  })
  const tab = state.createUnifiedTab(`${id}-workspace`, 'terminal', {
    executionHostId: host,
    label: `${id} session`,
    entityId: `${id}-terminal`
  })
  useAppStore.setState({
    activeWorktreeId: tab.worktreeId,
    activeWorkspaceExecutionHostId: host,
    tabsByWorktree: {
      ...useAppStore.getState().tabsByWorktree,
      [tab.worktreeId]: [
        {
          id: tab.entityId,
          worktreeId: tab.worktreeId,
          ptyId: null,
          title: tab.label,
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    }
  })
  state.initializeWindowPanes()
  state.synchronizeWindowPaneSelection()
  return tab
}

import { create } from 'zustand'
import type { AgentPickerDraft } from '../../../../shared/agent-launch-picker'
import { isFloatingWorkspaceId } from '../../../../shared/floating-workspace-worktree'
import type { AppState } from '@/store/types'
import { EMPTY_THREAD_IDS } from '../native-chat/structured-session-summary-store'
import { desktopThreadIds, visibleGroupActiveTabId } from './desktop-tab-projection'

// Only pages that have no selected session need window-local intent.
export type ThreadSelection =
  | { kind: 'new'; projectKey: string; draftId: string; launchDraft?: AgentPickerDraft }
  | { kind: 'workbench'; worktreeId: string; executionHostId: string | null }
export type ThreadPage =
  | Extract<ThreadSelection, { kind: 'new' }>
  | { kind: 'thread'; tabId: string; worktreeId: string }
  | null
export const useThreadNavigation = create<{
  selection: ThreadSelection | null
  request: number
  projectRequest: { request: number; selection: ThreadSelection | null } | null
}>(() => ({
  selection: null,
  request: 0,
  projectRequest: null
}))
export function clearThreadSelection(): number {
  const request = useThreadNavigation.getState().request + 1
  useThreadNavigation.setState({ selection: null, request, projectRequest: null })
  return request
}

/** recordFocus:false is layout maintenance, and floating panels own their own foreground. */
export function commitDesktopTabNavigation(
  state: Pick<AppState, 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'>,
  worktreeId: string,
  hostId: string | undefined,
  recordFocus?: boolean
): void {
  if (
    recordFocus !== false &&
    !isFloatingWorkspaceId(worktreeId) &&
    state.activeWorktreeId === worktreeId &&
    (!hostId ||
      !state.activeWorkspaceExecutionHostId ||
      state.activeWorkspaceExecutionHostId === hostId)
  ) {
    clearThreadSelection()
  }
}

export function changeThreadDraftProject(draftId: string, projectKey: string): void {
  const { selection } = useThreadNavigation.getState()
  if (selection?.kind === 'new' && selection.draftId === draftId) {
    useThreadNavigation.setState({ selection: { ...selection, projectKey } })
  }
}

type PageState = Pick<
  AppState,
  | 'settings'
  | 'activeView'
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
  | 'groupsByWorktree'
  | 'activeGroupIdByWorktree'
>
export function resolveDesktopThreadPage({
  enabled,
  activeView,
  worktreeId,
  hostId,
  tabId,
  hidden,
  intent
}: {
  enabled: boolean
  activeView: AppState['activeView']
  worktreeId: string | null
  hostId: string | null
  tabId: string | null | undefined
  hidden: ReadonlySet<string>
  intent: ThreadSelection | null
}): ThreadPage {
  if (!enabled || activeView !== 'terminal') {
    return null
  }
  if (intent?.kind === 'new') {
    return intent
  }
  if (
    !worktreeId ||
    (intent?.kind === 'workbench' &&
      intent.worktreeId === worktreeId &&
      intent.executionHostId === hostId)
  ) {
    return null
  }
  return tabId && hidden.has(tabId) ? { kind: 'thread', tabId, worktreeId } : null
}
export function activeThreadSelection(state: PageState): ThreadPage {
  const worktreeId = state.activeWorktreeId
  const group = worktreeId
    ? state.groupsByWorktree[worktreeId]?.find(
        (g) => g.id === state.activeGroupIdByWorktree[worktreeId]
      )
    : undefined
  return resolveDesktopThreadPage({
    enabled: state.settings?.experimentalThreads === true,
    activeView: state.activeView,
    worktreeId,
    hostId: state.activeWorkspaceExecutionHostId,
    tabId: group?.activeTabId,
    hidden: worktreeId ? desktopThreadIds(state, worktreeId) : EMPTY_THREAD_IDS,
    intent: useThreadNavigation.getState().selection
  })
}

/** An explicit workspace open shows its visible MRU; an empty projection has no host selection to write. */
export function openDesktopWorkbench(state: AppState, worktreeId: string): void {
  clearThreadSelection()
  const group = state.groupsByWorktree[worktreeId]?.find(
    (g) => g.id === state.activeGroupIdByWorktree[worktreeId]
  )
  const hidden = desktopThreadIds(state, worktreeId)
  if (!group?.activeTabId || !hidden.has(group.activeTabId)) {
    return
  }
  const next = visibleGroupActiveTabId(group, hidden)
  if (next) {
    state.activateTab(next, { worktreeId })
    state.focusGroup(worktreeId, group.id)
  } else {
    useThreadNavigation.setState({
      selection: {
        kind: 'workbench',
        worktreeId,
        executionHostId: state.activeWorkspaceExecutionHostId
      }
    })
  }
}

export function requestThreadProjectAdd(): void {
  const { request, selection } = useThreadNavigation.getState()
  useThreadNavigation.setState({ projectRequest: { request, selection } })
}

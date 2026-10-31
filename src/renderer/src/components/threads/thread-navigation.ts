import { requestNativeChatComposerFocus } from '../native-chat/use-native-chat-composer-reveal-focus'
import { create } from 'zustand'
import type { AgentPickerDraft } from '../../../../shared/agent-launch-picker'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { isWebClientLocation } from '@/lib/web-client-location'
import {
  presentDesktopWorkspace,
  beginDesktopNavigation,
  commitDesktopNavigation,
  type DesktopNavigationRequest
} from '@/lib/desktop-navigation'
import { EMPTY_THREAD_IDS } from '../native-chat/structured-session-summary-store'
import {
  readNativeChatComposerDraft,
  deleteNativeChatComposerDraft
} from '../native-chat/native-chat-composer-draft-store'
import { desktopThreadIds } from './desktop-tab-projection'

export type ThreadDraft = {
  kind: 'new'
  projectKey: string
  draftId: string
  launchDraft?: AgentPickerDraft
}
export type ThreadPage = ThreadDraft | { kind: 'thread'; tabId: string; worktreeId: string } | null

// Content survives navigation; only the app route decides whether compose is foreground.
export const useThreadDraft = create<{
  draft: ThreadDraft | null
  projectRequest: { request: DesktopNavigationRequest; draftId: string | null } | null
}>(() => ({ draft: null, projectRequest: null }))

let browserDraftAddress: string | undefined

export function threadDraftScopeKey(): string {
  // Desktop has one main renderer per profile. Browser windows own separate session addresses.
  if (!isWebClientLocation()) {
    return 'thread-draft:main'
  }
  const key = 'orca-new-thread-window'
  if (!browserDraftAddress) {
    const navigation = performance.getEntriesByType('navigation')[0]
    // A new browsing context can inherit sessionStorage; only reload reuses its address.
    browserDraftAddress = createBrowserUuid()
    try {
      if (navigation && 'type' in navigation && navigation.type === 'reload') {
        browserDraftAddress = sessionStorage.getItem(key) ?? browserDraftAddress
      }
      sessionStorage.setItem(key, browserDraftAddress)
    } catch {
      // Restricted storage still leaves this window's in-memory composer usable.
    }
  }
  return `thread-draft:${browserDraftAddress}`
}

export function enterThreadDraft(projectKey: string, request?: DesktopNavigationRequest): void {
  const { draft } = useThreadDraft.getState()
  useThreadDraft.setState({
    draft: draft
      ? { ...draft, projectKey }
      : { kind: 'new', projectKey, draftId: createBrowserUuid() }
  })
  if (request) {
    presentDesktopWorkspace(useAppStore.getState(), request, 'thread-draft')
  } else {
    useAppStore.getState().setActiveView('thread-draft')
  }
  requestNativeChatComposerFocus(threadDraftScopeKey())
}

export function changeThreadDraftProject(draftId: string, projectKey: string): void {
  const { draft } = useThreadDraft.getState()
  if (draft?.draftId === draftId) {
    beginDesktopNavigation(useAppStore.getState(), true)
    useThreadDraft.setState({ draft: { ...draft, projectKey } })
  }
}

export function consumeThreadDraft(submitted: ThreadDraft): void {
  const current = useThreadDraft.getState().draft
  if (
    current?.draftId === submitted.draftId &&
    current.projectKey === submitted.projectKey &&
    current.launchDraft === submitted.launchDraft &&
    !readNativeChatComposerDraft(threadDraftScopeKey()).text
  ) {
    useThreadDraft.setState({
      draft: { kind: 'new', projectKey: current.projectKey, draftId: createBrowserUuid() }
    })
  }
}

export function discardThreadDraft(): void {
  deleteNativeChatComposerDraft(threadDraftScopeKey())
  useThreadDraft.setState({ draft: null, projectRequest: null })
  const request = beginDesktopNavigation()
  commitDesktopNavigation(request, () => useAppStore.getState().setActiveView('terminal'))
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
  tabId,
  hidden,
  draft
}: {
  enabled: boolean
  activeView: AppState['activeView']
  worktreeId: string | null
  tabId: string | null | undefined
  hidden: ReadonlySet<string>
  draft: ThreadDraft | null
}): ThreadPage {
  if (!enabled) {
    return null
  }
  if (activeView === 'thread-draft') {
    return draft
  }
  if (activeView !== 'terminal' || !worktreeId) {
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
    tabId: group?.activeTabId,
    hidden: worktreeId ? desktopThreadIds(state, worktreeId) : EMPTY_THREAD_IDS,
    draft: useThreadDraft.getState().draft
  })
}

export { openDesktopWorkbench } from '@/lib/desktop-navigation-request'

export function requestThreadProjectAdd(
  request = beginDesktopNavigation(useAppStore.getState(), true)
): void {
  useThreadDraft.setState({
    projectRequest: { request, draftId: useThreadDraft.getState().draft?.draftId ?? null }
  })
}

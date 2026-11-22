import { useMemo } from 'react'
import { create } from 'zustand'
import { useAppStore } from '@/store/index'
import { findPage, findWorkspace } from '@/store/slices/browser/pages/browser-page-records'
import { getBrowserSessionProfileHostId } from '@/store/slices/browser/hosts/browser-host-state'
import { getExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { resolveSshWorkspaceBrowserRouteEligibility } from '@/lib/browser/workspace/ssh-workspace-browser-route-eligibility'
import {
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import {
  browserBookmarkScopeKey,
  type BrowserBookmark,
  type BrowserBookmarks,
  type BrowserBookmarkScope
} from '../../../../../shared/browser/bookmarks/browser-bookmarks'

const useBookmarkState = create<{ bookmarks: BrowserBookmarks | null; failed: boolean }>(() => ({
  bookmarks: null,
  failed: false
}))
const EMPTY_BOOKMARKS: readonly BrowserBookmark[] = []

export function installBrowserBookmarks(): () => void {
  const api = window.api.browser.bookmarks
  if (!api) {
    return () => {}
  }
  let acceptInitialList = true
  const publish = (bookmarks: BrowserBookmarks): void => {
    useBookmarkState.setState({ bookmarks, failed: false })
  }
  const unsubscribe = api.onChanged((bookmarks) => {
    acceptInitialList = false
    publish(bookmarks)
  })
  void api.list().then(
    (bookmarks) => {
      if (acceptInitialList) {
        publish(bookmarks)
      }
    },
    (error: unknown) => {
      if (acceptInitialList) {
        console.error('[browser] Could not load bookmarks:', error)
        useBookmarkState.setState({ failed: true })
      }
    }
  )
  return () => {
    acceptInitialList = false
    unsubscribe()
  }
}

export function useBrowserBookmarks(pageId: string) {
  const page = useAppStore((state) => findPage(state.browserPagesByWorkspace, pageId))
  const workspace = useAppStore((state) =>
    page ? findWorkspace(state.browserTabsByWorktree, page.workspaceId) : null
  )
  const hostKey = useAppStore((state) => {
    if (!page) {
      return null
    }
    const profileHost = getBrowserSessionProfileHostId(
      state,
      page.worktreeId,
      page.browserRuntimeEnvironmentId
    )
    if (parseExecutionHostId(profileHost)?.kind === 'runtime') {
      return profileHost
    }
    const route = resolveSshWorkspaceBrowserRouteEligibility(
      getExecutionHostIdForWorktree(state, page.worktreeId),
      state.settings,
      state.runtimeEnvironments
    )
    return route?.eligible ? toSshExecutionHostId(route.targetId) : null
  })
  const profileId = workspace ? (workspace.sessionProfileId ?? 'default') : null
  const scope = useMemo<BrowserBookmarkScope | null>(
    () => (profileId === null ? null : [hostKey, profileId]),
    [hostKey, profileId]
  )
  const key = scope && browserBookmarkScopeKey(scope)
  const entries = useBookmarkState((state) =>
    key && state.bookmarks ? (state.bookmarks[key] ?? EMPTY_BOOKMARKS) : null
  )
  const failed = useBookmarkState((state) => state.failed)
  return { page, scope, key, entries, failed }
}

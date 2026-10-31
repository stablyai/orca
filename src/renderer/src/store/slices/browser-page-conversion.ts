import type {
  BrowserPage,
  BrowserPageConversionOrigin,
  BrowserPageDocLocation,
  BrowserWorkspace
} from '../../../../shared/browser-workspace-types'
import { browserPageDocLocationsEqual } from '../../../../shared/browser-page-doc-location'
import {
  buildBrowserPage,
  findPage,
  findWorkspace,
  mirrorWorkspaceFromActivePage
} from './browser-page-records'

/** Caller resolves web-target ownership; converted remote-worktree pages can remain client-hosted. Document targets are always local because this desktop mints grants. */
export type BrowserPageConversionTarget =
  | { kind: 'web'; url: string; browserRuntimeEnvironmentId?: string | null }
  | { kind: 'workspace-doc'; docLocation: BrowserPageDocLocation }

/** Default conversion starts two-entry history. Back consumes convertedFrom and records convertedTo; Forward consumes convertedTo and restores convertedFrom. */
export type BrowserPageConversionLeg = 'history-return' | 'history-advance'

export type BrowserPageConversionPlan = {
  oldPage: BrowserPage
  newPage: BrowserPage
  workspace: BrowserWorkspace
  nextPages: BrowserPage[]
  nextWorkspace: BrowserWorkspace
}

/** Replace across doc/web with fresh page ID in the same workspace. Old grant/guest teardown and new registration use disjoint main registries, requiring no asynchronous teardown order. */
export function planBrowserPageConversion(
  state: {
    browserTabsByWorktree: Record<string, BrowserWorkspace[]>
    browserPagesByWorkspace: Record<string, BrowserPage[]>
  },
  pageId: string,
  target: BrowserPageConversionTarget,
  options?: {
    leg?: BrowserPageConversionLeg
    /** The id main already holds the new page under. */
    newPageId?: string
  }
): BrowserPageConversionPlan | null {
  const oldPage = findPage(state.browserPagesByWorkspace, pageId)
  if (!oldPage) {
    return null
  }
  const workspace = findWorkspace(state.browserTabsByWorktree, oldPage.workspaceId)
  if (!workspace) {
    return null
  }
  if (target.kind === 'web' && !oldPage.docLocation) {
    // Web-to-web is navigation; conversion would drop loading/history/guest reuse semantics.
    return null
  }
  if (
    target.kind === 'workspace-doc' &&
    browserPageDocLocationsEqual(oldPage.docLocation ?? null, target.docLocation)
  ) {
    return null
  }

  const departed: BrowserPageConversionOrigin = oldPage.docLocation
    ? { kind: 'workspace-doc', docLocation: oldPage.docLocation }
    : // Stored URL already passed input fences; persist provenance with ownership, preserving absent IDs for inferred remote return.
      {
        kind: 'url',
        url: oldPage.url,
        ...(oldPage.browserRuntimeEnvironmentId !== undefined
          ? { browserRuntimeEnvironmentId: oldPage.browserRuntimeEnvironmentId }
          : {})
      }
  // Fresh pages inherit neither pointer; each crossing consumes one and records the other, keeping history two entries deep.
  const convertedFrom = options?.leg === 'history-return' ? null : departed
  const convertedTo = options?.leg === 'history-return' ? departed : null

  const newPage: BrowserPage = {
    ...(target.kind === 'workspace-doc'
      ? buildBrowserPage(
          workspace.id,
          oldPage.worktreeId,
          '',
          undefined,
          // Document grant is desktop-local even when worktree is remote.
          null,
          options?.newPageId,
          target.docLocation
        )
      : buildBrowserPage(
          workspace.id,
          oldPage.worktreeId,
          target.url,
          undefined,
          // Preserve local ownership or inferred worktree runtime mounts a stream without a handle. Property-present undefined intentionally requests inferred ownership for Back.
          'browserRuntimeEnvironmentId' in target
            ? target.browserRuntimeEnvironmentId
            : (oldPage.browserRuntimeEnvironmentId ?? null),
          options?.newPageId
        )),
    ...(convertedFrom ? { convertedFrom } : {}),
    ...(convertedTo ? { convertedTo } : {})
  }

  const currentPages = state.browserPagesByWorkspace[workspace.id] ?? []
  const nextPages = currentPages.map((page) => (page.id === pageId ? newPage : page))
  const nextWorkspace = mirrorWorkspaceFromActivePage(
    {
      ...workspace,
      activePageId: workspace.activePageId === pageId ? newPage.id : workspace.activePageId,
      pageIds: nextPages.map((page) => page.id)
    },
    nextPages
  )

  return { oldPage, newPage, workspace, nextPages, nextWorkspace }
}

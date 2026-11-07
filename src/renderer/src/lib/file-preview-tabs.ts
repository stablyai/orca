import { browserPageDocLocationsEqual } from '../../../shared/browser-page-doc-location'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { basename } from '@/lib/path'
import { activateBrowserWorkspaceTab } from '@/lib/browser/workspace/browser-workspace-tab-activation'
import type { CreateBrowserTabOptions } from '@/store/slices/browser/browser-slice-contract'
import { ORCA_BROWSER_BLANK_URL } from '../../../shared/constants'
import { findWorkspaceShowingDoc } from './file-preview-page-conversion'
import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { tabOrderAnchor } from '../../../shared/workspace-layout/tab-order'
import { captureBrowserLinkReveal } from './browser/navigation/browser-link-reveal'
import { beginLinkOpenRequest } from './link-open-request'
import { afterPendingEntityTabs } from '@/runtime/layout-owner-pending-tabs'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../shared/non-secure-context-uuid'
import { newGroupSplitOf } from '@/runtime/layout-owner-new-group-split'

export function captureFilePreviewActivation(
  state: AppState,
  worktreeId: string,
  targetGroupId?: string
) {
  if (!state.groupsByWorktree[worktreeId]?.length) {
    state.ensureWorktreeRootGroup(worktreeId)
    state = useAppStore.getState()
  }
  const isCurrentRequest = beginLinkOpenRequest()
  const reveal = captureBrowserLinkReveal(useAppStore.getState, useAppStore.subscribe)
  const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
  const creationSplit =
    ORCA_LAYOUT_OWNER_IS_MAIN && activeGroupId
      ? newGroupSplitOf(state, worktreeId, activeGroupId, '')
      : null
  const selectedGroups =
    state.groupsByWorktree[worktreeId]?.filter(
      (group) => group.id === activeGroupId || group.id === targetGroupId
    ) ?? []
  let ownsSelection = true
  let relocation: { tabId: string; groupId: string } | undefined
  let createdPageId: string | undefined
  const observe = (current: AppState): void => {
    const groups = current.groupsByWorktree[worktreeId] ?? []
    const createdTab = createdPageId
      ? current.unifiedTabsByWorktree[worktreeId]?.find(
          (tab) =>
            tab.contentType === 'browser' &&
            current.browserPagesByWorkspace[tab.entityId]?.some((page) => page.id === createdPageId)
        )
      : undefined
    const move = relocation
    const relocated =
      move !== undefined &&
      current.unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.id === move.tabId)?.groupId ===
        move.groupId
    ownsSelection &&=
      (current.activeGroupIdByWorktree[worktreeId] === activeGroupId ||
        // Main materializes an empty split beside its source before we activate the preview.
        (createdTab?.groupId === activeGroupId &&
          creationSplit &&
          current.activeGroupIdByWorktree[worktreeId] === creationSplit.split.besideGroupId) ||
        (relocated &&
          !groups.some((group) => group.id === activeGroupId) &&
          current.activeGroupIdByWorktree[worktreeId] === relocation?.groupId)) &&
      selectedGroups.every((selected) => {
        const activeTabId = groups.find((group) => group.id === selected.id)?.activeTabId
        return (
          activeTabId === selected.activeTabId ||
          (selected.activeTabId === null &&
            createdTab !== undefined &&
            activeTabId === createdTab.id) ||
          (relocated && selected.activeTabId === relocation?.tabId)
        )
      })
  }
  const unsubscribe = useAppStore.subscribe(observe)
  return {
    expectCreation: (pageId: string) => {
      createdPageId = pageId
    },
    expectRelocation: (tabId: string, groupId: string) => {
      relocation = { tabId, groupId }
    },
    canActivate: () => {
      observe(useAppStore.getState())
      return isCurrentRequest() && ownsSelection && reveal.canReveal()
    },
    dispose: () => {
      unsubscribe()
      reveal.dispose()
    }
  }
}

type FilePreviewActivation = ReturnType<typeof captureFilePreviewActivation>

export function createFilePreviewTab(
  state: AppState,
  worktreeId: string,
  url: string,
  options: CreateBrowserTabOptions,
  activation?: FilePreviewActivation
): void {
  try {
    const browserPageId = activation ? (options.browserPageId ?? createBrowserUuid()) : undefined
    if (browserPageId) {
      activation?.expectCreation(browserPageId)
    }
    const created = state.createBrowserTab(worktreeId, url, {
      ...options,
      ...(activation ? { activate: false, browserPageId } : {})
    })
    if (activation) {
      afterPendingEntityTabs(worktreeId, created.id, () => {
        try {
          if (activation.canActivate()) {
            activateBrowserWorkspaceTab({
              worktreeId,
              workspaceId: created.id,
              pageId: created.activePageId ?? undefined
            })
          }
        } finally {
          activation.dispose()
        }
      })
    }
  } catch (error) {
    activation?.dispose()
    throw error
  }
}

export function openDocPreviewTab(
  state: AppState,
  params: {
    filePath: string
    worktreeId: string
    activate: boolean
    placementWorkspaceId?: string
  },
  placement?: Pick<CreateBrowserTabOptions, 'targetGroupId' | 'split'>,
  activation?: FilePreviewActivation
): void {
  const docLocation = {
    kind: 'workspace-doc' as const,
    worktreeId: params.worktreeId,
    filePath: params.filePath
  }
  // Reuse the document’s tab; opening another would mint a second grant for the same file.
  const placementWorkspaceId = params.placementWorkspaceId ?? params.worktreeId
  const existing =
    placementWorkspaceId === params.worktreeId
      ? findWorkspaceShowingDoc(state, docLocation)
      : (state.browserTabsByWorktree[placementWorkspaceId] ?? []).flatMap((tab) => {
          const page = (state.browserPagesByWorkspace[tab.id] ?? []).find((candidate) =>
            browserPageDocLocationsEqual(candidate.docLocation ?? null, docLocation)
          )
          return page ? [{ workspaceId: tab.id, pageId: page.id }] : []
        })[0]
  if (existing) {
    const activateExisting = (): void => {
      try {
        if (activation && !activation.canActivate()) {
          return
        }
        if (
          !params.activate ||
          !activateBrowserWorkspaceTab({
            worktreeId: placementWorkspaceId,
            ...existing
          })
        ) {
          const current = useAppStore.getState()
          current.setActiveBrowserTab(existing.workspaceId)
          current.setActiveBrowserPage(existing.workspaceId, existing.pageId)
        }
      } finally {
        activation?.dispose()
      }
    }
    // A unified tab owns every page in its browser workspace; only a single-page preview can move.
    if (
      params.activate &&
      placement?.targetGroupId &&
      state.browserPagesByWorkspace[existing.workspaceId]?.length === 1
    ) {
      const tab = state.unifiedTabsByWorktree[placementWorkspaceId]?.find(
        (candidate) =>
          candidate.contentType === 'browser' && candidate.entityId === existing.workspaceId
      )
      if (tab && tab.groupId !== placement.targetGroupId) {
        const targetGroupId = placement.targetGroupId
        activation?.expectRelocation(tab.id, targetGroupId)
        const order = state.groupsByWorktree[placementWorkspaceId]?.find(
          (group) => group.id === targetGroupId
        )?.tabOrder
        if (
          ORCA_LAYOUT_OWNER_IS_MAIN &&
          order &&
          sendLayoutCommandToOwner(
            placementWorkspaceId,
            {
              type: 'moveTab',
              tabId: tab.id,
              toGroupId: targetGroupId,
              index: order.length,
              afterTabId: tabOrderAnchor(order, order.length)
            },
            {
              apply: activateExisting,
              asToday: () => {
                if (activation && !activation.canActivate()) {
                  activation.dispose()
                  return
                }
                useAppStore.getState().moveUnifiedTabToGroup(tab.id, targetGroupId)
                activateExisting()
              },
              refused: () => {
                activation?.dispose()
                toast.error('Could not move the preview to this pane. Try again.')
              }
            }
          )
        ) {
          return
        }
        state.moveUnifiedTabToGroup(tab.id, placement.targetGroupId)
      }
    }
    activateExisting()
    return
  }
  createFilePreviewTab(
    state,
    placementWorkspaceId,
    ORCA_BROWSER_BLANK_URL,
    {
      docLocation,
      title: basename(params.filePath) || params.filePath,
      ...placement,
      // The preview grant is minted on this desktop, so the page stays explicitly client-local even for remote worktrees.
      browserRuntimeEnvironmentId: null,
      // Foreground file opens follow the reader; side previews must leave their source visible.
      activate: params.activate
    },
    activation
  )
}

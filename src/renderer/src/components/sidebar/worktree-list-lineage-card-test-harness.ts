import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

export const mockStore: { state: Record<string, unknown> } = { state: {} }

export type WorktreeListComponent = React.ComponentType<{
  scrollOffsetRef: React.RefObject<number>
  scrollAnchorRef: React.RefObject<unknown>
}>

let WorktreeList: WorktreeListComponent | null = null

export async function loadWorktreeList(): Promise<void> {
  const module = await import('./WorktreeList')
  WorktreeList = module.default as WorktreeListComponent
}

export async function renderWorktreeListMarkup(): Promise<string> {
  return renderToStaticMarkup(
    React.createElement(WorktreeList!, {
      scrollOffsetRef: { current: 0 },
      scrollAnchorRef: { current: null }
    })
  )
}

export function createAppStoreModuleMock(): Record<string, unknown> {
  const getMockState = (): Record<string, unknown> => ({
    detectedWorktreesByRepo: {},
    ...mockStore.state
  })
  const useAppStore = ((selector: (state: Record<string, unknown>) => unknown) =>
    selector(getMockState())) as ((
    selector: (state: Record<string, unknown>) => unknown
  ) => unknown) & {
    getState: () => Record<string, unknown>
  }
  useAppStore.getState = () => getMockState()
  return { useAppStore }
}

export function createReactVirtualModuleMock(): Record<string, unknown> {
  return {
    defaultRangeExtractor: ({ startIndex, endIndex }: { startIndex: number; endIndex: number }) =>
      Array.from({ length: endIndex - startIndex + 1 }, (_, index) => startIndex + index),
    measureElement: () => 32,
    useVirtualizer: ({ count }: { count: number }) => ({
      elementsCache: new Map(),
      getTotalSize: () => count * 80,
      getVirtualItems: () =>
        Array.from({ length: count }, (_, index) => ({
          index,
          key: `row-${index}`,
          start: index * 80
        })),
      measureElement: vi.fn(),
      scrollToIndex: vi.fn()
    })
  }
}

export function createVirtualizedScrollAnchorModuleMock(): Record<string, unknown> {
  return {
    VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT: 'orca:test-record-scroll-anchor',
    useVirtualizedScrollAnchor: vi.fn()
  }
}

export function createProjectHeaderDragModuleMock(): Record<string, unknown> {
  return {
    useRepoHeaderDrag: () => ({
      state: { draggingRepoId: null, dropIndicatorY: null },
      onHandlePointerDown: vi.fn()
    })
  }
}

export function createWorktreeCardModuleMock(): Record<string, unknown> {
  return {
    default: ({
      worktree,
      repo,
      isActive,
      contentIndent,
      flushSurface,
      renameRowKey,
      lineageChildCount,
      lineageCollapsed,
      lineageChildren
    }: {
      worktree: Worktree
      repo?: Repo
      isActive?: boolean
      contentIndent?: number
      flushSurface?: boolean
      renameRowKey?: string
      lineageChildCount?: number
      lineageCollapsed?: boolean
      lineageChildren?: React.ReactNode
    }) => {
      const deleteStateByWorktreeId =
        (mockStore.state.deleteStateByWorktreeId as Record<
          string,
          { isDeleting?: boolean } | undefined
        >) ?? {}
      const cardProps = (mockStore.state.worktreeCardProperties as string[] | undefined) ?? []
      const sshState =
        repo?.connectionId && mockStore.state.sshConnectionStates instanceof Map
          ? mockStore.state.sshConnectionStates.get(repo.connectionId)
          : null
      const isDeleting = deleteStateByWorktreeId[worktree.id]?.isDeleting === true
      const showSshDialog = isActive && repo?.connectionId && sshState?.status !== 'connected'
      // Why: the real WorktreeCard owns the inline-rename surface and decides
      // begin-editing from renameRowKey + renamingWorktreeId, so mirror that here
      // to verify WorktreeList hands each row its row-scoped rename key.
      const renamingRequest = mockStore.state.renamingWorktreeId as {
        worktreeId: string
        rowKey?: string
      } | null
      const beginEditing =
        renamingRequest?.worktreeId === worktree.id &&
        (renamingRequest.rowKey === undefined || renamingRequest.rowKey === renameRowKey)

      return React.createElement(
        'section',
        {
          'data-worktree-card-id': worktree.id,
          'data-worktree-card-active': isActive ? 'true' : undefined,
          'data-content-indent': contentIndent,
          'data-flush-surface': flushSurface ? 'true' : undefined,
          'data-begin-editing': beginEditing ? 'true' : undefined,
          'data-lineage-child-count': lineageChildCount,
          'data-lineage-collapsed':
            lineageCollapsed === undefined ? undefined : String(lineageCollapsed),
          'data-linked-pr': worktree.linkedPR ?? undefined,
          'data-linked-gitlab-mr': worktree.linkedGitLabMR ?? undefined,
          'aria-busy': isDeleting ? 'true' : undefined
        },
        React.createElement('h2', null, worktree.displayName),
        isDeleting ? React.createElement('span', null, 'Deleting') : null,
        cardProps.includes('status') && worktree.isUnread
          ? React.createElement('button', { 'aria-label': 'Mark as read' }, 'Unread')
          : null,
        lineageChildCount
          ? React.createElement(
              'button',
              {
                'data-lineage-toggle-for': worktree.id,
                'aria-expanded': lineageCollapsed ? 'false' : 'true'
              },
              `${lineageChildCount} ${lineageChildCount === 1 ? 'child' : 'children'}`
            )
          : null,
        showSshDialog
          ? React.createElement('aside', {
              'data-worktree-card-ssh-dialog': 'open',
              'data-ssh-status': sshState?.status ?? 'disconnected',
              'data-ssh-target-id': repo?.connectionId
            })
          : null,
        lineageChildren
      )
    },
    shouldBeginWorktreeRename: (
      request: { worktreeId: string; rowKey?: string } | null,
      worktreeId: string,
      rowKey?: string
    ) =>
      request?.worktreeId === worktreeId &&
      (request.rowKey === undefined || request.rowKey === rowKey)
  }
}

export function createWorktreeCardAgentsModuleMock(): Record<string, unknown> {
  return {
    default: ({ worktreeId }: { worktreeId: string }) =>
      React.createElement(
        'div',
        { role: 'group', 'aria-label': 'Agents', 'data-agent-worktree-id': worktreeId },
        'Review fixture prompt'
      )
  }
}

export function createWorktreeTitleInlineRenameModuleMock(): Record<string, unknown> {
  return {
    WorktreeTitleInlineRename: ({
      beginEditing,
      displayName
    }: {
      beginEditing?: boolean
      displayName: string
    }) =>
      React.createElement(
        'span',
        {
          'data-worktree-title-inline-rename': '',
          'data-begin-editing': beginEditing ? 'true' : undefined
        },
        displayName
      )
  }
}

export function createWorktreeContextMenuModuleMock(): Record<string, unknown> {
  return {
    default: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    CLOSE_ALL_CONTEXT_MENUS_EVENT: 'orca:test-close-context-menus',
    WORKTREE_CONTEXT_MENU_SCOPE_ATTR: 'data-orca-context-menu-scope'
  }
}

export function createTooltipModuleMock(): Record<string, unknown> {
  return {
    Tooltip: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    TooltipContent: ({ children }: { children: React.ReactNode }) =>
      React.createElement('span', null, children),
    TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children)
  }
}

export function createDropdownMenuModuleMock(): Record<string, unknown> {
  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    DropdownMenuItem: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', null, children),
    DropdownMenuLabel: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', null, children),
    DropdownMenuSeparator: () => React.createElement('hr'),
    DropdownMenuSub: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    DropdownMenuSubTrigger: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', null, children),
    DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children)
  }
}

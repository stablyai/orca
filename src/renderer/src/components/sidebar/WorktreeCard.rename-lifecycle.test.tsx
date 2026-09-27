// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { WorktreeRenameRequest } from './worktree-card-model'
import { makeRepo, makeWorktree } from './worktree-list-lineage-card-test-fixtures'

let request: WorktreeRenameRequest | null = null
let settings: Partial<GlobalSettings> = {}
let sleeping = false
const consumeRename = vi.fn((next: WorktreeRenameRequest | null) => {
  request = next
})
const updateWorktreeMeta = vi.fn()
const hover = vi.hoisted((): { change?: (open: boolean) => void; intent?: () => void } => ({}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      browserTabsByWorktree: {},
      createBrowserTab: vi.fn(),
      deleteFolderWorkspace: vi.fn(),
      deleteStateByWorktreeId: {},
      fetchHostedReviewForBranch: vi.fn(),
      fetchIssue: vi.fn(),
      fetchLinearIssue: vi.fn(),
      gitConflictOperationByWorktree: {},
      hostedReviewCache: {},
      issueCache: {},
      linearIssueCache: {},
      openModal: vi.fn(),
      openTaskPage: vi.fn(),
      projectGroups: [],
      ptyIdsByTabId: {},
      remoteBranchConflictByWorktreeId: {},
      renamingWorktreeId: request,
      setActiveWorktree: vi.fn(),
      setRemoteBrowserPageHandle: vi.fn(),
      setRenamingWorktreeId: consumeRename,
      settings,
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map(),
      tabsByWorktree: {},
      updateWorktreeMeta,
      workspacePortScan: null,
      worktreeCardProperties: ['status', 'branch', 'comment']
    })
}))
vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({
    children,
    open,
    onOpenChange
  }: {
    children: ReactNode
    open?: boolean
    onOpenChange?: (open: boolean) => void
  }) => {
    hover.change = onOpenChange
    return <div data-hover-open={String(open)}>{children}</div>
  },
  HoverCardContent: () => null,
  HoverCardTrigger: ({
    children,
    onPointerEnter
  }: {
    children: ReactNode
    onPointerEnter?: (event: { pointerType: string }) => void
  }) => {
    hover.intent = () => onPointerEnter?.({ pointerType: 'mouse' })
    return <>{children}</>
  }
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))
vi.mock('@/lib/sidebar-worktree-activation', () => ({ activateWorktreeFromSidebar: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))
vi.mock('./use-worktree-activity-status', () => ({ useWorktreeActivityStatus: () => 'idle' }))
vi.mock('./use-worktree-sleep-state', () => ({ useIsSleepingWorktree: () => sleeping }))
vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownStartedAt: () => null
}))
vi.mock('./WorktreeCardAgents', () => ({ default: () => null }))
vi.mock('./WorktreeContextMenu', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
  CLOSE_ALL_CONTEXT_MENUS_EVENT: 'orca:test-close-context-menus',
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR: 'data-orca-context-menu-scope',
  WORKTREE_NATIVE_CONTEXT_MENU_ATTR: 'data-worktree-native-context-menu'
}))
vi.mock('@/components/workspace-emoji/WorkspaceEmojiSuggestionPopover', () => ({
  WorkspaceEmojiSuggestionPopover: () => null
}))
vi.mock('@/components/workspace-emoji/useWorkspaceEmojiShortcodeInput', () => ({
  useWorkspaceEmojiShortcodeInput: ({
    onValueChange
  }: {
    onValueChange: (value: string) => void
  }) => ({
    close: vi.fn(),
    commandValue: '',
    handleKeyDown: () => false,
    handleValueChange: onValueChange,
    onCommandValueChange: vi.fn(),
    open: false,
    selectSuggestion: vi.fn(),
    suggestions: [],
    syncCursor: vi.fn()
  })
}))
import WorktreeCard from './WorktreeCard'

beforeEach(() => {
  request = null
  settings = { experimentalNewWorktreeCardStyle: true }
  sleeping = false
  hover.change = undefined
  vi.clearAllMocks()
  updateWorktreeMeta.mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const repo = makeRepo()
const worktree = makeWorktree({
  id: 'leaf',
  displayName: 'Reading workspace',
  branch: 'feature',
  instanceId: 'leaf',
  sortOrder: 0
})
const rowKey = 'all:local|leaf'
function card(comment = '') {
  return (
    <WorktreeCard
      worktree={{ ...worktree, comment }}
      repo={repo}
      isActive={false}
      nativeDragEnabled
      renameRowKey={rowKey}
    />
  )
}
function editor(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('[data-worktree-title-rename-input]')
  if (!input) {
    throw new Error('Expected the admitted inline rename editor')
  }
  return input
}

describe('WorktreeCard parent rename lifecycle', () => {
  it.each([false, true])(
    'keeps an admitted editor focused through details refresh, sleeping=%s',
    (isSleeping) => {
      sleeping = isSleeping
      const view = render(card())
      act(() => {
        hover.intent?.()
        hover.change?.(true)
      })
      expect(view.container.querySelector('[data-hover-open="true"]')).not.toBeNull()
      const focus = vi.spyOn(HTMLInputElement.prototype, 'focus')
      request = { worktreeId: worktree.id, rowKey }
      view.rerender(card())
      const input = editor(view.container)
      expect(consumeRename).toHaveBeenCalledExactlyOnceWith(null)
      expect(document.activeElement).toBe(input)
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
      expect(
        view.container.querySelector('[data-worktree-card-surface]')?.getAttribute('draggable')
      ).toBe('false')
      expect(view.container.querySelector('[data-hover-open="true"]')).toBeNull()
      fireEvent.change(input, { target: { value: 'Half typed draft' } })
      input.setSelectionRange(3, 8)
      act(() => hover.change?.(true))
      for (const comment of ['Refreshed details', '', 'More details']) {
        view.rerender(card(comment))
        expect(editor(view.container)).toBe(input)
        expect(input.value).toBe('Half typed draft')
        expect([input.selectionStart, input.selectionEnd]).toEqual([3, 8])
        expect(document.activeElement).toBe(input)
        expect(view.container.querySelector('[data-hover-open="true"]')).toBeNull()
      }
      expect(focus).toHaveBeenCalledTimes(1)
      fireEvent.keyDown(input, { key: 'Escape' })
      expect(view.container.querySelector('[data-worktree-title-rename-input]')).toBeNull()
      expect(
        view.container.querySelector('[data-worktree-card-surface]')?.getAttribute('draggable')
      ).toBe('true')
      expect(view.container.querySelector('[data-hover-open="true"]')).toBeNull()
      act(() => {
        hover.intent?.()
        hover.change?.(true)
      })
      expect(view.container.querySelector('[data-hover-open="true"]')).not.toBeNull()
      expect(updateWorktreeMeta).not.toHaveBeenCalled()
    }
  )
  it('does not reopen an old hover when an inline rename ends without pointer events', () => {
    const view = render(card())
    act(() => {
      hover.intent?.()
      hover.change?.(true)
    })
    expect(view.container.querySelector('[data-hover-open="true"]')).not.toBeNull()
    request = { worktreeId: worktree.id, rowKey }
    view.rerender(card())
    fireEvent.keyDown(editor(view.container), { key: 'Escape' })
    expect(view.container.querySelector('[data-hover-open="true"]')).toBeNull()
    act(() => {
      hover.intent?.()
      hover.change?.(true)
    })
    expect(view.container.querySelector('[data-hover-open="true"]')).not.toBeNull()
  })
  it.each([false, true])(
    'saves a double-click rename without replacing its editor, new style=%s',
    async (newStyle) => {
      settings = { experimentalNewWorktreeCardStyle: newStyle }
      const view = render(card())
      const title = view.container.querySelector<HTMLElement>(
        '[data-worktree-title-inline-rename]'
      )!
      fireEvent.doubleClick(title)
      const input = editor(view.container)
      fireEvent.change(input, { target: { value: 'Renamed workspace' } })
      view.rerender(card('Updated details'))
      expect(editor(view.container)).toBe(input)
      await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))
      expect(updateWorktreeMeta).toHaveBeenCalledExactlyOnceWith(
        worktree.id,
        { displayName: 'Renamed workspace' },
        { executionHostId: 'local' }
      )
      expect(view.container.querySelector('[data-worktree-title-rename-input]')).toBeNull()
      expect(
        view.container.querySelector('[data-worktree-card-surface]')?.getAttribute('draggable')
      ).toBe('true')
      expect(view.container.querySelector('[data-hover-open="true"]')).toBeNull()
    }
  )
})

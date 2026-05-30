import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type {
  BrowserTab as BrowserTabState,
  GitFileStatus,
  TerminalTab
} from '../../../../shared/types'
import type { OpenFile } from '../../store/slices/editor'
import type { TabDragItemData } from '../tab-group/useTabDragSplit'
import BrowserTab from './BrowserTab'
import EditorFileTab from './EditorFileTab'
import SortableTab from './SortableTab'

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: ({ id }: { id: string }) => ({
    attributes: {
      role: 'tab',
      tabIndex: 0,
      'data-sortable-id': id
    },
    listeners: {
      onPointerDown: vi.fn()
    },
    setNodeRef: vi.fn()
  })
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <div data-tooltip-root>{children}</div>,
  TooltipContent: ({
    children,
    className,
    side,
    sideOffset
  }: {
    children: ReactNode
    className?: string
    side?: string
    sideOffset?: number
  }) => (
    <div data-tooltip-content data-side={side} data-side-offset={sideOffset} className={className}>
      {children}
    </div>
  ),
  TooltipTrigger: ({ children, asChild }: { children: ReactNode; asChild?: boolean }) => {
    if (asChild && isValidElement(children)) {
      return cloneElement(children as ReactElement<Record<string, unknown>>, {
        'data-tooltip-trigger': 'true'
      })
    }
    return <span data-tooltip-trigger>{children}</span>
  }
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: () => null,
  DropdownMenuItem: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuSeparator: () => null,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />
}))

vi.mock('../sidebar/WorktreeCardHelpers', () => ({
  FilledBellIcon: () => <span data-filled-bell />
}))

vi.mock('./shell-icons', () => ({
  ShellIcon: () => <span data-shell-icon />
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { unreadTerminalTabs: Record<string, boolean> }) => unknown) =>
    selector({ unreadTerminalTabs: {} })
}))

vi.mock('@/store', () => ({
  useAppStore: (
    selector: (state: {
      openMarkdownPreview: () => void
      settings: null
      unreadTerminalTabs: Record<string, boolean>
    }) => unknown
  ) => selector({ openMarkdownPreview: vi.fn(), settings: null, unreadTerminalTabs: {} })
}))

vi.mock('@/store/selectors', () => ({
  useRepoById: () => ({ connectionId: null }),
  useWorktreeById: () => ({ path: '/repo', repoId: 'repo-1' })
}))

vi.mock('../browser-pane/browser-runtime', () => ({
  getLiveBrowserUrl: () => 'https://live.example/not-the-tab-label'
}))

vi.mock('@/lib/file-type-icons', () => ({
  getFileTypeIcon: () =>
    function FileIcon() {
      return <span data-file-icon />
    }
}))

vi.mock('@/lib/rename-file', () => ({
  renameFileOnDisk: vi.fn()
}))

vi.mock('@/lib/language-detect', () => ({
  detectLanguage: () => 'typescript'
}))

vi.mock('@/components/editor/markdown-preview-controls', () => ({
  canOpenMarkdownPreview: () => false
}))

vi.mock('@/lib/local-path-open-guard', () => ({
  showLocalPathOpenBlockedToast: vi.fn()
}))

vi.mock('./editor-tab-local-open-guard', () => ({
  shouldBlockEditorTabLocalOpen: () => false
}))

function makeDragData(tabType: TabDragItemData['tabType'], visibleTabId: string): TabDragItemData {
  return {
    kind: 'tab',
    worktreeId: 'wt-1',
    groupId: 'group-1',
    unifiedTabId: `unified-${visibleTabId}`,
    visibleTabId,
    tabType,
    label: visibleTabId
  }
}

function openingTag(markup: string, attr: string, value: string): string {
  const match = markup.match(new RegExp(`<div(?=[^>]*${attr}="${value}")[^>]*>`))
  if (!match) {
    throw new Error(`opening div with ${attr}="${value}" not found in ${markup}`)
  }
  return match[0]
}

function expectTooltipContent(markup: string, text: string): void {
  expect(markup).toContain('data-tooltip-content="true"')
  expect(markup).toContain('data-side="bottom"')
  expect(markup).toContain('data-side-offset="6"')
  expect(markup).toContain('max-w-80 whitespace-normal break-words text-left')
  expect(markup).toContain(text)
}

function makeTerminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'terminal-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Runtime terminal title',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function makeBrowserTab(overrides: Partial<BrowserTabState> = {}): BrowserTabState {
  return {
    id: 'browser-1',
    worktreeId: 'wt-1',
    url: 'https://example.com/docs/long-browser-tab-path',
    title: 'Browser title',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0,
    ...overrides
  }
}

function makeEditorFile(overrides: Partial<OpenFile & { tabId?: string }> = {}): OpenFile & {
  tabId?: string
} {
  return {
    id: '/repo/src/components/VeryLongEditorFileName.tsx',
    tabId: 'editor-tab-1',
    filePath: '/repo/src/components/VeryLongEditorFileName.tsx',
    relativePath: 'src/components/VeryLongEditorFileName.tsx',
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

describe('tab title tooltips', () => {
  it('uses the terminal custom title for the visible label and tooltip trigger content', () => {
    const markup = renderToStaticMarkup(
      <SortableTab
        tab={makeTerminalTab({ customTitle: 'Custom terminal title' })}
        tabCount={1}
        hasTabsToRight={false}
        isActive={true}
        isExpanded={false}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onCloseOthers={vi.fn()}
        onCloseToRight={vi.fn()}
        onSetCustomTitle={vi.fn()}
        onSetTabColor={vi.fn()}
        onToggleExpand={vi.fn()}
        onSplitGroup={vi.fn()}
        dragData={makeDragData('terminal', 'terminal-1')}
      />
    )

    expectTooltipContent(markup, 'Custom terminal title')
    expect(markup).not.toContain('Runtime terminal title')
    const root = openingTag(markup, 'data-testid', 'sortable-tab')
    expect(root).toContain('data-tooltip-trigger="true"')
    expect(root).toContain('role="tab"')
    expect(root).toContain('tabindex="0"')
  })

  it('uses the browser tab fallback label from the tab prop, not the live URL', () => {
    const markup = renderToStaticMarkup(
      <BrowserTab
        tab={makeBrowserTab({ title: '' })}
        isActive={false}
        hasTabsToRight={false}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onCloseToRight={vi.fn()}
        onSplitGroup={vi.fn()}
        onDuplicate={vi.fn()}
        dragData={makeDragData('browser', 'browser-1')}
      />
    )

    expectTooltipContent(markup, 'example.com/docs/long-browser-tab-path')
    expect(markup).not.toContain('live.example')
    const root = openingTag(markup, 'data-sortable-id', 'browser-1')
    expect(root).toContain('data-tooltip-trigger="true"')
    expect(root).toContain('role="tab"')
    expect(root).toContain('tabindex="0"')
  })

  it('uses the editor display label while leaving adjacent adornments outside the label', () => {
    const markup = renderToStaticMarkup(
      <EditorFileTab
        file={makeEditorFile({ externalMutation: 'renamed', isPreview: true })}
        isActive={false}
        hasTabsToRight={false}
        statusByRelativePath={new Map<string, GitFileStatus>()}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onCloseToRight={vi.fn()}
        onCloseAll={vi.fn()}
        onPin={vi.fn()}
        onSplitGroup={vi.fn()}
        dragData={makeDragData('editor', 'editor-tab-1')}
      />
    )

    expectTooltipContent(markup, 'VeryLongEditorFileName.tsx')
    expect(markup).toContain('line-through')
    expect(markup).toContain('renamed')
    const root = openingTag(markup, 'data-sortable-id', 'editor-tab-1')
    expect(root).toContain('data-tooltip-trigger="true"')
    expect(root).toContain('role="tab"')
    expect(root).toContain('tabindex="0"')
  })
})

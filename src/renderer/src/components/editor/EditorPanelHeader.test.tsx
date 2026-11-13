// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../../shared/types'
import type { OpenFile } from '@/store/slices/editor'
import { EditorPanelHeader } from './EditorPanelHeader'

const storeState = {
  activeGroupIdByWorktree: { 'wt-1': 'group-1' },
  agentSendPopoverTargetMode: null,
  clearDeliveredDiffComments: vi.fn(),
  closeAgentSendPopoverTargetMode: vi.fn(),
  getDiffComments: vi.fn(),
  keybindings: {},
  openAgentSendPopoverTargetMode: vi.fn(),
  settings: { diffWordWrap: false },
  updateSettings: vi.fn(),
  worktreesByRepo: {}
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (s: typeof storeState) => unknown) => selector(storeState)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace(/\{\{value0\}\}/g, values?.value0 ?? '')
}))

vi.mock('./EditorPanelHeaderPath', () => ({
  EditorPanelHeaderPath: () => <div data-testid="editor-header-path" />
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuCheckboxItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuShortcut: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  DropdownMenuSub: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('./ReviewNotesSendMenuContent', () => ({
  ReviewNotesSendMenuContent: () => null
}))

const activeFile: OpenFile = {
  id: '/repo/src/app.ts',
  filePath: '/repo/src/app.ts',
  relativePath: 'src/app.ts',
  worktreeId: 'wt-1',
  language: 'typescript',
  isDirty: false,
  mode: 'edit'
}

const diffComment: DiffComment = {
  id: 'comment-1',
  worktreeId: 'wt-1',
  filePath: 'src/app.ts',
  source: 'diff',
  lineNumber: 12,
  body: 'Please adjust this',
  createdAt: 1,
  side: 'modified'
}

const defaultHeaderProps = {
  activeFile,
  copiedPathVisible: false,
  isSingleDiff: false,
  isDiffSurface: true,
  isMarkdown: false,
  isCsv: false,
  isNotebook: false,
  hasEditorToggle: false,
  availableEditorToggleModes: [],
  effectiveToggleValue: 'edit' as const,
  canOpenPreviewToSide: false,
  canShowMarkdownPreview: false,
  canShowMarkdownTableOfContents: false,
  isMarkdownTableOfContentsDisabled: false,
  shouldShowMarkdownExportAction: false,
  canExportMarkdownToPdf: false,
  showMarkdownTableOfContents: false,
  canShowMarkdownFrontmatterToggle: false,
  markdownFrontmatterVisible: false,
  sideBySide: false,
  openFileState: { canOpen: false },
  onCopyPath: vi.fn(),
  onOpenDiffTargetFile: vi.fn(),
  onOpenPreviewToSide: vi.fn(),
  onOpenMarkdownPreview: vi.fn(),
  onOpenContainingFolder: vi.fn(),
  onToggleSideBySide: vi.fn(),
  onEditorToggleChange: vi.fn(),
  onToggleMarkdownTableOfContents: vi.fn(),
  onToggleMarkdownFrontmatter: vi.fn(),
  onExportMarkdownToPdf: vi.fn()
}

function renderHeader(
  comments: readonly DiffComment[],
  props: Partial<React.ComponentProps<typeof EditorPanelHeader>> = {}
): void {
  storeState.getDiffComments.mockReturnValue(comments)
  render(<EditorPanelHeader {...defaultHeaderProps} {...props} />)
}

describe('EditorPanelHeader diff notes send gate', () => {
  beforeEach(() => {
    storeState.getDiffComments.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows the batch-send control for Changes mode when the active file has diff comments', () => {
    renderHeader([diffComment], { isDiffSurface: true, isSingleDiff: false })

    expect(screen.getByRole('button', { name: 'Send AI notes to an agent' })).not.toBeNull()
  })

  it('hides the batch-send control for Changes mode when the active file has no diff comments', () => {
    renderHeader([], { isDiffSurface: true, isSingleDiff: false })

    expect(screen.queryByRole('button', { name: 'Send AI notes to an agent' })).toBeNull()
  })

  it('keeps showing the batch-send control for single-file diff tabs with comments', () => {
    renderHeader([diffComment], { isDiffSurface: true, isSingleDiff: true })

    expect(screen.getByRole('button', { name: 'Send AI notes to an agent' })).not.toBeNull()
  })
})

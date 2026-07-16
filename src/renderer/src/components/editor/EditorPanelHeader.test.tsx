import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { EditorPanelHeader } from './EditorPanelHeader'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      activeGroupIdByWorktree: {},
      settings: {},
      updateSettings: vi.fn()
    })
}))

vi.mock('@/store/worktree-diff-comments-selector', () => ({
  selectWorktreeDiffCommentsOrEmpty: () => []
}))

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({
    children,
    delayDuration
  }: {
    children: React.ReactNode
    delayDuration: number
  }) => (
    <div data-tooltip-provider data-delay-duration={delayDuration}>
      {children}
    </div>
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => <span data-tooltip>{children}</span>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>
}))

vi.mock('./EditorPanelHeaderPath', () => ({
  EditorPanelHeaderPath: () => null
}))

vi.mock('./EditorPanelMarkdownActionsMenu', () => ({
  EditorPanelMarkdownActionsMenu: () => null
}))

vi.mock('./diff-navigation-context', () => ({
  useDiffNavigation: () => ({
    changeCount: 2,
    goToPreviousDiff: vi.fn(),
    goToNextDiff: vi.fn()
  })
}))

const activeFile: OpenFile = {
  id: 'diff:/repo/file.ts',
  filePath: '/repo/file.ts',
  relativePath: 'file.ts',
  worktreeId: 'repo::/repo',
  language: 'typescript',
  isDirty: false,
  mode: 'diff'
}

describe('EditorPanelHeader', () => {
  it('shares one tooltip provider across the diff header controls', () => {
    const html = renderToStaticMarkup(
      <EditorPanelHeader
        activeFile={activeFile}
        copiedPathVisible={false}
        isSingleDiff={false}
        isDiffSurface
        isMarkdown={false}
        isCsv={false}
        isNotebook={false}
        hasEditorToggle={false}
        availableEditorToggleModes={[]}
        effectiveToggleValue="edit"
        canOpenPreviewToSide={false}
        canShowMarkdownPreview={false}
        canShowMarkdownTableOfContents={false}
        isMarkdownTableOfContentsDisabled={false}
        shouldShowMarkdownExportAction={false}
        canExportMarkdownToPdf={false}
        showMarkdownTableOfContents={false}
        canShowMarkdownFrontmatterToggle={false}
        markdownFrontmatterVisible={false}
        sideBySide={false}
        openFileState={{ canOpen: false }}
        onCopyPath={vi.fn()}
        onOpenDiffTargetFile={vi.fn()}
        onOpenPreviewToSide={vi.fn()}
        onOpenMarkdownPreview={vi.fn()}
        onOpenContainingFolder={vi.fn()}
        onToggleSideBySide={vi.fn()}
        onEditorToggleChange={vi.fn()}
        onToggleMarkdownTableOfContents={vi.fn()}
        onToggleMarkdownFrontmatter={vi.fn()}
        onExportMarkdownToPdf={vi.fn()}
      />
    )

    expect(html.match(/data-tooltip-provider/g)).toHaveLength(1)
    expect(html.match(/data-tooltip="true"/g)).toHaveLength(3)
    expect(html).toContain('data-delay-duration="300"')
    expect(html).toContain('aria-label="Previous change"')
    expect(html).toContain('aria-label="Next change"')
  })
})

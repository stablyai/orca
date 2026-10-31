// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { EditorPanelHeader } from './EditorPanelHeader'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const updateSettings = vi.hoisted(() => vi.fn())

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      activeGroupIdByWorktree: {},
      settings: {},
      updateSettings
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

vi.mock('./EditorPanelActionsMenu', () => ({
  EditorPanelActionsMenu: ({ fileLocationActions }: { fileLocationActions?: React.ReactNode }) =>
    fileLocationActions ?? null
}))

vi.mock('./EditorFileLocationMenuItems', () => ({
  EditorFileLocationMenuItems: () => <span data-file-location-actions />
}))

vi.mock('@/components/artifacts/ArtifactPublishButton', () => ({
  ArtifactPublishButton: () => <button data-artifact-publish />
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

const baseProps = {
  activeFile,
  copiedPathVisible: false,
  isSingleDiff: false,
  isDiffSurface: true,
  isMarkdown: false,
  isCsv: false,
  isNotebook: false,
  hasEditorToggle: false,
  availableEditorToggleModes: [],
  effectiveToggleValue: 'edit',
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
  onToggleSideBySide: vi.fn(),
  onEditorToggleChange: vi.fn(),
  onToggleMarkdownTableOfContents: vi.fn(),
  onToggleMarkdownFrontmatter: vi.fn(),
  onExportMarkdownToPdf: vi.fn()
} satisfies ComponentProps<typeof EditorPanelHeader>

function renderHeader(overrides: Partial<ComponentProps<typeof EditorPanelHeader>> = {}): string {
  return renderToStaticMarkup(<EditorPanelHeader {...baseProps} {...overrides} />)
}

describe('EditorPanelHeader', () => {
  it.each(['edit', 'markdown-preview'] as const)('offers file actions for %s tabs', (mode) => {
    expect(renderHeader({ activeFile: { ...activeFile, mode } })).toContain(
      'data-file-location-actions'
    )
  })

  it.each(['diff', 'conflict-review', 'check-details'] as const)(
    'does not offer on-disk file actions for %s documents',
    (mode) => {
      expect(renderHeader({ activeFile: { ...activeFile, mode } })).not.toContain(
        'data-file-location-actions'
      )
    }
  )

  it('offers file actions for a diff with an openable working file', () => {
    expect(renderHeader({ isSingleDiff: true, openFileState: { canOpen: true } })).toContain(
      'data-file-location-actions'
    )
    expect(renderHeader({ isSingleDiff: true, openFileState: { canOpen: false } })).not.toContain(
      'data-file-location-actions'
    )
  })

  it('shares one tooltip provider across the diff header controls', () => {
    const html = renderHeader()

    expect(html.match(/data-tooltip-provider/g)).toHaveLength(1)
    expect(html.match(/data-tooltip="true"/g)).toHaveLength(3)
    expect(html).toContain('data-delay-duration="300"')
    expect(html).toContain('aria-label="Previous change"')
    expect(html).toContain('aria-label="Next change"')
  })

  it('offers artifact sharing on non-diff surfaces given a shareable document', () => {
    const createRequest = vi.fn()

    expect(
      renderHeader({
        isDiffSurface: false,
        isMarkdown: false,
        createArtifactRequest: createRequest
      })
    ).toContain('data-artifact-publish="true"')
    expect(
      renderHeader({
        isDiffSurface: true,
        isMarkdown: true,
        createArtifactRequest: createRequest
      })
    ).not.toContain('data-artifact-publish')
    expect(
      renderHeader({
        isDiffSurface: false,
        isMarkdown: true
      })
    ).not.toContain('data-artifact-publish')
  })

  it('renders the line numbers button and persists the off choice', () => {
    updateSettings.mockClear()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(<EditorPanelHeader {...baseProps} canToggleLineNumbers isDiffSurface={false} />)
    })

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Hide line numbers"]'
    )
    expect(button?.getAttribute('aria-pressed')).toBe('true')
    expect(button?.className).toContain('bg-accent')

    act(() => {
      button?.click()
    })
    expect(updateSettings).toHaveBeenCalledWith({ editorLineNumbers: false })

    act(() => root.unmount())
    container.remove()
  })

  it('disables line numbers while a rich preview is showing', () => {
    const html = renderHeader({
      canToggleLineNumbers: true,
      isDiffSurface: false,
      isMarkdown: true,
      effectiveToggleValue: 'rich'
    })

    expect(html).toContain('aria-label="Line numbers are available in source or diff mode"')
    expect(html).toContain('disabled=""')
    expect(html).toContain('aria-pressed="false"')
  })

  it('omits the line numbers button when the surface cannot toggle them', () => {
    expect(renderHeader({ canToggleLineNumbers: false, isDiffSurface: false })).not.toContain(
      'Hide line numbers'
    )
  })
})

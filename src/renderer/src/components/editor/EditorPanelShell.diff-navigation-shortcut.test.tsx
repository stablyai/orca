// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { EditorPanelShell } from './EditorPanelShell'

const navigationMock = vi.hoisted(() => ({
  goToNextDiff: vi.fn(),
  goToPreviousDiff: vi.fn()
}))

vi.mock('./diff-navigation-context', () => ({
  useDiffNavigation: () => navigationMock
}))

vi.mock('./EditorPanelHeader', () => ({
  EditorPanelHeader: () => <button type="button">header</button>
}))

vi.mock('./EditorContent', () => ({
  EditorContent: () => <div data-editor-content tabIndex={0} />
}))

vi.mock('./UntitledFileRenameDialog', () => ({
  UntitledFileRenameDialog: () => null
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({ worktreesByRepo: {}, keybindings: {} }),
    { getState: () => ({ worktreesByRepo: {}, keybindings: {} }) }
  )
}))

function openFile(): OpenFile {
  return {
    id: '/repo/src/image.bin',
    filePath: '/repo/src/image.bin',
    relativePath: 'src/image.bin',
    worktreeId: 'wt-1',
    language: 'plaintext',
    mode: 'edit'
  } as OpenFile
}

function model(overrides: Partial<Record<string, unknown>> = {}): never {
  return {
    isCombinedDiff: false,
    isSingleDiff: false,
    isDiffSurface: true,
    isChangesMode: false,
    hasWorktreeDiffNavigation: true,
    isMarkdown: false,
    isMermaid: false,
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
    openFileState: { canOpen: false },
    worktreeEntries: [],
    resolvedLanguage: 'plaintext',
    mdViewMode: 'rich',
    ...overrides
  } as never
}

function renderShell(shellModel = model()): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const file = openFile()
  const noop = (): void => {}
  act(() => {
    root.render(
      <EditorPanelShell
        panelRef={null}
        activeFile={file}
        activeViewStateId={file.id}
        model={shellModel}
        copiedPathVisible={false}
        showMarkdownTableOfContents={false}
        canShowMarkdownFrontmatterToggle={false}
        markdownFrontmatterVisible={false}
        sideBySide={false}
        openFiles={[file]}
        fileContents={{}}
        diffContents={{}}
        editorDrafts={{}}
        pendingEditorReveal={null}
        renameDialogFile={null}
        renameError={null}
        disableRenameBrowse={false}
        onCopyPath={noop}
        onOpenDiffTargetFile={noop}
        onOpenPreviewToSide={noop}
        onOpenMarkdownPreview={noop}
        onOpenContainingFolder={noop}
        onToggleSideBySide={noop}
        onEditorToggleChange={noop}
        onToggleMarkdownTableOfContents={noop}
        onToggleMarkdownFrontmatter={noop}
        onExportMarkdownToPdf={noop}
        onContentChange={noop}
        onContentChangeForFile={noop}
        onDirtyStateHint={noop}
        onSave={async () => true}
        onSaveForFile={async () => true}
        onReloadContent={noop}
        onCloseMarkdownTableOfContents={noop}
        onCloseRenameDialog={noop}
        onRenameConfirm={async () => {}}
        markdownAnnotationsEnabled={false}
      />
    )
  })
  return { root, container }
}

describe('EditorPanelShell worktree diff navigation shortcut fallback', () => {
  let mounted: { root: Root; container: HTMLDivElement } | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    navigationMock.goToNextDiff.mockReset()
    navigationMock.goToPreviousDiff.mockReset()
  })

  afterEach(() => {
    if (mounted) {
      act(() => mounted?.root.unmount())
      mounted.container.remove()
    }
    mounted = null
  })

  it('routes F7 and Shift+F7 through diff navigation when no Monaco diff editor is mounted', () => {
    mounted = renderShell()
    const target = mounted.container.firstElementChild as HTMLElement

    const nextEvent = new KeyboardEvent('keydown', { key: 'F7', bubbles: true, cancelable: true })
    target.dispatchEvent(nextEvent)
    expect(nextEvent.defaultPrevented).toBe(true)
    expect(navigationMock.goToNextDiff).toHaveBeenCalledOnce()

    const previousEvent = new KeyboardEvent('keydown', {
      key: 'F7',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })
    target.dispatchEvent(previousEvent)
    expect(previousEvent.defaultPrevented).toBe(true)
    expect(navigationMock.goToPreviousDiff).toHaveBeenCalledOnce()
  })

  it('does not install the fallback shortcut while a Monaco changes diff is mounted', () => {
    mounted = renderShell(model({ isChangesMode: true }))
    const target = mounted.container.firstElementChild as HTMLElement

    const event = new KeyboardEvent('keydown', { key: 'F7', bubbles: true, cancelable: true })
    target.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    expect(navigationMock.goToNextDiff).not.toHaveBeenCalled()
  })
})

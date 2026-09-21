import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { EditorPanelShell } from './EditorPanelShell'

// Why stub both children: the claim under test is which of them the shell renders for a given tab
// mode, and mounting the real editor surface would drag in Monaco for a layout question.
vi.mock('./EditorPanelHeader', () => ({
  EditorPanelHeader: () => <div data-editor-panel-header />
}))

vi.mock('./EditorContent', () => ({
  EditorContent: () => <div data-editor-content />
}))

vi.mock('./UntitledFileRenameDialog', () => ({
  UntitledFileRenameDialog: () => null
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({ worktreesByRepo: {} }),
    { getState: () => ({ worktreesByRepo: {} }) }
  )
}))

function openFile(mode: OpenFile['mode']): OpenFile {
  return {
    id: `file-${mode}`,
    filePath: '/home/alice/docs/report/index.html',
    relativePath: 'report/index.html',
    worktreeId: 'wt-1',
    language: 'html',
    mode
  } as OpenFile
}

function renderShell(file: OpenFile, isCombinedDiff = false): string {
  const model = {
    isCombinedDiff,
    isSingleDiff: false,
    isDiffSurface: false,
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
    resolvedLanguage: 'html',
    mdViewMode: 'rich'
  }
  const noop = (): void => {}
  return renderToStaticMarkup(
    <EditorPanelShell
      panelRef={null}
      activeFile={file}
      activeViewStateId={file.id}
      model={model as never}
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
}

describe('EditorPanelShell path header', () => {
  // Why assert every remaining mode: a gate that hides the header everywhere would satisfy the
  // check-details claim below while silently removing the path from every ordinary file tab.
  it.each(['edit', 'diff', 'conflict-review', 'markdown-preview'] as const)(
    'keeps the header for a %s tab',
    (mode) => {
      expect(renderShell(openFile(mode))).toContain('data-editor-panel-header')
    }
  )

  it('hides the header for check-details and combined diffs, as it always has', () => {
    expect(renderShell(openFile('check-details'))).not.toContain('data-editor-panel-header')
    expect(renderShell(openFile('edit'), true)).not.toContain('data-editor-panel-header')
  })

  it('renders the editor surface either way', () => {
    expect(renderShell(openFile('check-details'))).toContain('data-editor-content')
    expect(renderShell(openFile('edit'))).toContain('data-editor-content')
  })
})

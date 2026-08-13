import { Suspense } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'

// Why: EditorContent's mode renderers (Monaco, DiffViewer, ...) are lazy();
// renderToStaticMarkup cannot resolve them. Stubbing them keeps the banner
// branch structure renderable so its placement is pinned by tests.
vi.mock('@/lib/lazy-with-retry', () => ({
  lazyWithRetry: () => () => null
}))

import { EditorContent, getMarkdownSourceLineOffset } from './EditorContent'
import { SPREADSHEET_FILE_MIME_TYPES } from '../../../../shared/spreadsheet-file-extensions'

function createOpenFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: '/repo/notebook.ipynb',
    filePath: '/repo/notebook.ipynb',
    relativePath: 'notebook.ipynb',
    worktreeId: 'repo::/repo',
    language: 'notebook',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('EditorContent', () => {
  it('maps rich-editor annotation lines after front matter to source lines', () => {
    expect(getMarkdownSourceLineOffset('---\ntitle: x\n---\n')).toBe(3)
    expect(getMarkdownSourceLineOffset('+++\ntitle = "x"\n+++\n')).toBe(3)
    expect(getMarkdownSourceLineOffset('---\r\ntitle: x\r\n---\r\n')).toBe(3)
    expect(getMarkdownSourceLineOffset('---\rtitle: x\n---\r\n')).toBe(3)
  })

  it('counts newline-heavy front matter offsets without regex match', () => {
    const matchSpy = vi.spyOn(String.prototype, 'match')
    const frontMatterRaw = `---\n${'title: x\n'.repeat(12_000)}---\n`

    expect(getMarkdownSourceLineOffset(frontMatterRaw)).toBe(12_002)
    expect(matchSpy).not.toHaveBeenCalled()
  })

  it('surfaces file load errors before notebook content is parsed', () => {
    const activeFile = createOpenFile()
    const html = renderToStaticMarkup(
      <EditorContent
        activeFile={activeFile}
        viewStateScopeId={activeFile.id}
        fileContents={{
          [activeFile.id]: {
            content: '',
            isBinary: false,
            loadError: 'Access denied: path resolves outside allowed directories.'
          }
        }}
        diffContents={{}}
        editBuffers={{}}
        openFiles={[activeFile]}
        worktreeEntries={[]}
        resolvedLanguage="notebook"
        isMarkdown={false}
        isMermaid={false}
        isCsv={false}
        isNotebook
        mdViewMode="rich"
        isChangesMode={false}
        sideBySide={false}
        pendingEditorReveal={null}
        handleContentChange={vi.fn()}
        handleContentChangeForFile={vi.fn()}
        handleDirtyStateHint={vi.fn()}
        handleSave={vi.fn()}
        handleSaveForFile={vi.fn()}
        reloadContent={vi.fn()}
      />
    )

    expect(html).toContain('Unable to load file')
    expect(html).toContain('Access denied')
    expect(html).not.toContain('Unable to render notebook')
  })

  it('shows the changed-on-disk banner above a dirty edit tab', () => {
    const activeFile = createOpenFile({
      id: '/repo/file.ts',
      filePath: '/repo/file.ts',
      relativePath: 'file.ts',
      language: 'typescript',
      isDirty: true,
      externalMutation: 'changed'
    })
    const html = renderToStaticMarkup(
      <EditorContent
        activeFile={activeFile}
        viewStateScopeId={activeFile.id}
        fileContents={{ [activeFile.id]: { content: 'saved text', isBinary: false } }}
        diffContents={{}}
        editBuffers={{ [activeFile.id]: 'saved text plus edits' }}
        openFiles={[activeFile]}
        worktreeEntries={[]}
        resolvedLanguage="typescript"
        isMarkdown={false}
        isMermaid={false}
        isCsv={false}
        isNotebook={false}
        mdViewMode="rich"
        isChangesMode={false}
        sideBySide={false}
        pendingEditorReveal={null}
        handleContentChange={vi.fn()}
        handleContentChangeForFile={vi.fn()}
        handleDirtyStateHint={vi.fn()}
        handleSave={vi.fn()}
        handleSaveForFile={vi.fn()}
        reloadContent={vi.fn()}
      />
    )

    expect(html).toContain('role="alert"')
    expect(html).toContain('changed on disk')
    expect(html).toContain('Reload from Disk')
  })

  it('shows the changed-on-disk banner above a dirty unstaged diff without collapsing it', () => {
    const activeFile = createOpenFile({
      id: 'diff:/repo/file.ts',
      filePath: '/repo/file.ts',
      relativePath: 'file.ts',
      language: 'typescript',
      mode: 'diff',
      diffSource: 'unstaged',
      isDirty: true,
      externalMutation: 'changed'
    })
    const html = renderToStaticMarkup(
      <EditorContent
        activeFile={activeFile}
        viewStateScopeId={activeFile.id}
        fileContents={{}}
        diffContents={{
          [activeFile.id]: { kind: 'text', originalContent: 'old', modifiedContent: 'new' } as never
        }}
        editBuffers={{ [activeFile.id]: 'new plus edits' }}
        openFiles={[activeFile]}
        worktreeEntries={[]}
        resolvedLanguage="typescript"
        isMarkdown={false}
        isMermaid={false}
        isCsv={false}
        isNotebook={false}
        mdViewMode="rich"
        isChangesMode={false}
        sideBySide={false}
        pendingEditorReveal={null}
        handleContentChange={vi.fn()}
        handleContentChangeForFile={vi.fn()}
        handleDirtyStateHint={vi.fn()}
        handleSave={vi.fn()}
        handleSaveForFile={vi.fn()}
        reloadContent={vi.fn()}
      />
    )

    expect(html).toContain('role="alert"')
    expect(html).toContain('changed on disk')
    // Why: the diff-mode wrapper must give the viewer its height back — a
    // flex-1-only wrapper collapsed the DiffViewer to 0px (found live).
    expect(html).toContain('flex h-full min-h-0 flex-col')
  })

  it('shows the changed-on-disk banner on a dirty markdown diff in preview mode', () => {
    const activeFile = createOpenFile({
      id: 'diff:/repo/notes.md',
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      language: 'markdown',
      mode: 'diff',
      diffSource: 'unstaged',
      isDirty: true,
      externalMutation: 'changed'
    })
    const html = renderToStaticMarkup(
      <EditorContent
        activeFile={activeFile}
        viewStateScopeId={activeFile.id}
        fileContents={{}}
        diffContents={{
          [activeFile.id]: { kind: 'text', originalContent: 'old', modifiedContent: 'new' } as never
        }}
        editBuffers={{ [activeFile.id]: 'new plus edits' }}
        openFiles={[activeFile]}
        worktreeEntries={[]}
        resolvedLanguage="markdown"
        isMarkdown
        isMermaid={false}
        isCsv={false}
        isNotebook={false}
        mdViewMode="preview"
        isChangesMode={false}
        sideBySide={false}
        pendingEditorReveal={null}
        handleContentChange={vi.fn()}
        handleContentChangeForFile={vi.fn()}
        handleDirtyStateHint={vi.fn()}
        handleSave={vi.fn()}
        handleSaveForFile={vi.fn()}
        reloadContent={vi.fn()}
      />
    )

    expect(html).toContain('role="alert"')
    expect(html).toContain('changed on disk')
    expect(html).toContain('Previewing the modified version of this diff')
  })
  it('routes a workbook to the spreadsheet viewer instead of the binary placeholder', () => {
    const activeFile = createOpenFile({
      id: '/repo/report.xlsx',
      filePath: '/repo/report.xlsx',
      relativePath: 'report.xlsx',
      language: 'plaintext'
    })
    const html = renderToStaticMarkup(
      <Suspense fallback={null}>
        <EditorContent
          activeFile={activeFile}
          viewStateScopeId={activeFile.id}
          fileContents={{
            [activeFile.id]: {
              content: '',
              isBinary: true,
              // Why: the read path marks every previewable binary as an image, so
              // the workbook branch has to win on mime type alone.
              isImage: true,
              mimeType: SPREADSHEET_FILE_MIME_TYPES['.xlsx']
            }
          }}
          diffContents={{}}
          editBuffers={{}}
          openFiles={[activeFile]}
          worktreeEntries={[]}
          resolvedLanguage="plaintext"
          isMarkdown={false}
          isMermaid={false}
          isCsv={false}
          isNotebook={false}
          mdViewMode="rich"
          isChangesMode={false}
          sideBySide={false}
          pendingEditorReveal={null}
          handleContentChange={vi.fn()}
          handleContentChangeForFile={vi.fn()}
          handleDirtyStateHint={vi.fn()}
          handleSave={vi.fn()}
          handleSaveForFile={vi.fn()}
          reloadContent={vi.fn()}
        />
      </Suspense>
    )

    // Why: the workbook viewer is code-split, so a synchronous static render
    // suspends and emits nothing. What matters is that the branch no longer
    // falls through to the "cannot display" placeholder.
    expect(html).toBe('')
  })

  it('still shows the binary placeholder for a binary it cannot preview', () => {
    const activeFile = createOpenFile({
      id: '/repo/app.bin',
      filePath: '/repo/app.bin',
      relativePath: 'app.bin',
      language: 'plaintext'
    })
    const html = renderToStaticMarkup(
      <EditorContent
        activeFile={activeFile}
        viewStateScopeId={activeFile.id}
        fileContents={{ [activeFile.id]: { content: '', isBinary: true } }}
        diffContents={{}}
        editBuffers={{}}
        openFiles={[activeFile]}
        worktreeEntries={[]}
        resolvedLanguage="plaintext"
        isMarkdown={false}
        isMermaid={false}
        isCsv={false}
        isNotebook={false}
        mdViewMode="rich"
        isChangesMode={false}
        sideBySide={false}
        pendingEditorReveal={null}
        handleContentChange={vi.fn()}
        handleContentChangeForFile={vi.fn()}
        handleDirtyStateHint={vi.fn()}
        handleSave={vi.fn()}
        handleSaveForFile={vi.fn()}
        reloadContent={vi.fn()}
      />
    )

    expect(html).toContain('Binary file')
  })
})

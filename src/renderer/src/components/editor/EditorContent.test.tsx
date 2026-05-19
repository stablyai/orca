import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { EditorContent, getMarkdownSourceLineOffset } from './EditorContent'

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

describe('EditorContent', () => {
  it('maps rich-editor annotation lines after front matter to source lines', () => {
    expect(getMarkdownSourceLineOffset('---\ntitle: x\n---\n')).toBe(3)
    expect(getMarkdownSourceLineOffset('+++\ntitle = "x"\n+++\n')).toBe(3)
    expect(getMarkdownSourceLineOffset('---\r\ntitle: x\r\n---\r\n')).toBe(3)
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
        reloadFileContent={vi.fn()}
      />
    )

    expect(html).toContain('Unable to load file')
    expect(html).toContain('Access denied')
    expect(html).not.toContain('Unable to render notebook')
  })
})

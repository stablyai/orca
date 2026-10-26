import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'

vi.mock('@/lib/lazy-with-retry', () => ({
  lazyWithRetry: () => () => null
}))

vi.mock('@/store', () => {
  const state = {
    settings: { editorCenteredLayout: true },
    markdownRichModeSizeOverride: {},
    setMarkdownRichModeSizeOverride: () => {},
    reloadOpenCheckRunDetailsTab: () => {}
  }
  return {
    useAppStore: Object.assign(
      (selector: (storeState: typeof state) => unknown) => selector(state),
      { getState: () => state }
    )
  }
})

vi.mock('./useMarkdownDocuments', () => ({
  useMarkdownDocuments: () => ({
    markdownDocuments: [],
    onOpenDocLink: () => {},
    previewProps: { markdownDocuments: [], onOpenDocument: async () => {} },
    mdSave: async () => false
  })
}))

vi.mock('./useEditorConflictNavigation', () => ({
  useEditorConflictNavigation: () => () => undefined
}))

import { EditorContent } from './EditorContent'

const activeFile: OpenFile = {
  id: '/repo/src/index.ts',
  filePath: '/repo/src/index.ts',
  relativePath: 'src/index.ts',
  worktreeId: 'repo::/repo',
  language: 'typescript',
  isDirty: false,
  mode: 'edit'
}

describe('EditorContent centered layout', () => {
  it('wraps the file editor column when the setting is on (#31236)', () => {
    const html = renderToStaticMarkup(
      <EditorContent
        activeFile={activeFile}
        viewStateScopeId={activeFile.id}
        fileContents={{ [activeFile.id]: { content: 'const n = 1\n', isBinary: false } }}
        diffContents={{}}
        editBuffers={{}}
        openFiles={[activeFile]}
        worktreeEntries={[]}
        resolvedLanguage="typescript"
        isMarkdown={false}
        isMermaid={false}
        isCsv={false}
        isNotebook={false}
        mdViewMode="source"
        inlineMarkdownRenderState={null}
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

    expect(html).toContain('data-editor-centered-layout="true"')
    expect(html).toContain('max-w-4xl')
    expect(html).toContain('justify-center')
  })
})

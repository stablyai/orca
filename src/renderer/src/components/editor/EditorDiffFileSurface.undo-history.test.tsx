// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { DiffViewerProps } from './diff-viewer-props'
import { getDiffViewerMonacoModelPaths } from './diff-monaco-model-disposal'
import { modelLifetimeTextModel, resetModelLifetimeFixtures } from './editor-model-lifetime-fixture'

const probe = vi.hoisted((): { props: DiffViewerProps | null } => ({ props: null }))

vi.mock('./editor-lazy-views', () => ({
  DiffViewer: (props: DiffViewerProps) => {
    probe.props = props
    return null
  },
  ImageDiffViewer: () => null,
  MarkdownPreview: () => null
}))

import { EditorDiffFileSurface } from './EditorDiffFileSurface'

const initialContent = 'const value = 1\n'
const editedContent = 'const value = 2\n'
const file: OpenFile = {
  id: 'diff-undo-fixture',
  filePath: '/fixture/workspace/example.ts',
  relativePath: 'example.ts',
  worktreeId: 'model-fixture::/fixture/workspace',
  language: 'typescript',
  mode: 'diff',
  diffSource: 'unstaged',
  isDirty: false
}

function surface(content: string, overrides: Partial<OpenFile> = {}) {
  const openDocument = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const save = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)
  return (
    <EditorDiffFileSurface
      activeFile={{ ...file, ...overrides }}
      diffContent={{
        kind: 'text',
        originalContent: initialContent,
        modifiedContent: content,
        originalIsBinary: false,
        modifiedIsBinary: false
      }}
      editBuffer={undefined}
      resolvedLanguage="typescript"
      sideBySide
      viewStateScopeId="diff-undo-fixture"
      diffViewStateKey="diff-undo-fixture"
      mdViewMode="source"
      isMarkdown={false}
      showMarkdownTableOfContents={false}
      onCloseMarkdownTableOfContents={vi.fn()}
      markdownAnnotationsEnabled={false}
      markdownDocuments={{
        markdownDocuments: [],
        openMarkdownDocument: openDocument,
        onOpenDocLink: vi.fn(),
        previewProps: { markdownDocuments: [], onOpenDocument: openDocument },
        mdSave: save
      }}
      onContentChange={vi.fn()}
      onSave={save}
      reloadContent={vi.fn()}
    />
  )
}

function activeModifiedModel(): monaco.editor.ITextModel {
  const props = probe.props
  if (!props) {
    throw new Error('Diff surface did not render')
  }
  const { modifiedModelPath } = getDiffViewerMonacoModelPaths({ ...props, generationSuffix: '' })
  const uri = monaco.Uri.parse(modifiedModelPath)
  return (
    monaco.editor.getModel(uri) ?? modelLifetimeTextModel(modifiedModelPath, props.modifiedContent)
  )
}

function edit(model: monaco.editor.ITextModel, text: string): void {
  model.pushStackElement()
  model.pushEditOperations(null, [{ range: model.getFullModelRange(), text }], () => null)
  model.pushStackElement()
}

afterEach(() => {
  cleanup()
  probe.props = null
  resetModelLifetimeFixtures()
})

describe('editable diff model identity', () => {
  it('keeps real Monaco Undo and Redo available after saving the modified text', async () => {
    const view = render(surface(initialContent))
    const beforeSave = activeModifiedModel()
    edit(beforeSave, editedContent)

    view.rerender(surface(editedContent))
    const afterSave = activeModifiedModel()
    await afterSave.undo()

    expect(afterSave.getValue()).toBe(initialContent)
    expect(afterSave).toBe(beforeSave)
    await afterSave.redo()
    expect(afterSave.getValue()).toBe(editedContent)
  })

  it('keeps a manual revert instead of resurrecting a retained edited model', () => {
    const view = render(surface(initialContent))
    edit(activeModifiedModel(), editedContent)
    view.rerender(surface(editedContent))
    edit(activeModifiedModel(), initialContent)

    view.rerender(surface(initialContent))

    expect(activeModifiedModel().getValue()).toBe(initialContent)
  })

  it('still starts a fresh model after an explicit external reload', async () => {
    const view = render(surface(initialContent))
    const beforeReload = activeModifiedModel()
    edit(beforeReload, editedContent)

    view.rerender(surface('external replacement\n', { diffContentReloadNonce: 1 }))
    const afterReload = activeModifiedModel()
    await afterReload.undo()

    expect(afterReload.getValue()).toBe('external replacement\n')
    expect(afterReload).not.toBe(beforeReload)
  })
})

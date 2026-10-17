// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiffViewerProps } from './diff-viewer-props'
import type { DiffContent } from './editor-panel-content-types'
import { EditorDiffFileSurface } from './EditorDiffFileSurface'

const captured = vi.hoisted((): { props: DiffViewerProps | null; mounts: number } => ({
  props: null,
  mounts: 0
}))
vi.mock('./editor-lazy-views', () => ({
  DiffViewer: (props: DiffViewerProps) => {
    captured.props = props
    useEffect(() => {
      captured.mounts++
    }, [])
    return <div>{props.modifiedContent}</div>
  },
  ImageDiffViewer: () => null,
  MarkdownPreview: () => null
}))
vi.mock('./ExternalFileChangeBanner', () => ({ ExternalFileChangeBanner: () => null }))

const onSave = vi.fn(async () => true)
const onContentChange = vi.fn()
const failedDiff = {
  kind: 'text',
  originalContent: '',
  modifiedContent: 'Error loading diff: connection lost',
  originalIsBinary: false,
  modifiedIsBinary: false,
  loadError: true
} satisfies DiffContent

function surface(editBuffer?: string, loadError = true): React.JSX.Element {
  return (
    <EditorDiffFileSurface
      activeFile={{
        id: 'diff-file',
        filePath: '/repo/file.ts',
        relativePath: 'file.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'diff',
        diffSource: 'unstaged',
        isDirty: editBuffer !== undefined
      }}
      diffContent={{ ...failedDiff, loadError }}
      editBuffer={editBuffer}
      resolvedLanguage="typescript"
      sideBySide
      viewStateScopeId="pane-1"
      diffViewStateKey="diff-file"
      mdViewMode="source"
      isMarkdown={false}
      showMarkdownTableOfContents={false}
      onCloseMarkdownTableOfContents={() => {}}
      markdownAnnotationsEnabled={false}
      markdownDocuments={{
        markdownDocuments: [],
        openMarkdownDocument: async () => {},
        onOpenDocLink: () => {},
        previewProps: { markdownDocuments: [], onOpenDocument: async () => {} },
        mdSave: onSave
      }}
      onContentChange={onContentChange}
      onSave={onSave}
      reloadContent={() => {}}
    />
  )
}

afterEach(() => {
  cleanup()
  captured.props = null
  captured.mounts = 0
  onSave.mockClear()
  onContentChange.mockClear()
})

describe('failed unstaged diff content', () => {
  it('keeps a load error out of both the draft and save paths', () => {
    render(surface())
    expect(captured.props?.modifiedContent).toBe(failedDiff.modifiedContent)
    expect(captured.props?.editable).toBe(false)
    expect(captured.props?.onContentChange).toBeUndefined()
    expect(captured.props?.onSave).toBeUndefined()
  })

  it.each(['retained draft', ''])(
    'keeps an existing draft %j editable and saveable',
    async (draft) => {
      render(surface(draft))
      expect(captured.props?.modifiedContent).toBe(draft)
      expect(captured.props?.editable).toBe(true)
      captured.props?.onContentChange?.('new draft')
      await captured.props?.onSave?.(draft)
      expect(onContentChange).toHaveBeenCalledExactlyOnceWith('new draft')
      expect(onSave).toHaveBeenCalledExactlyOnceWith(draft)
    }
  )

  it('allows a successfully loaded unstaged diff to be edited and saved', () => {
    render(surface(undefined, false))
    expect(captured.props?.editable).toBe(true)
    expect(captured.props?.onContentChange).toBe(onContentChange)
    expect(captured.props?.onSave).toBe(onSave)
  })

  it('recovers the same diff viewer when a reload succeeds', () => {
    const view = render(surface())
    expect(captured.props?.editable).toBe(false)
    view.rerender(surface(undefined, false))
    expect(captured.props?.editable).toBe(true)
    expect(captured.props?.onSave).toBe(onSave)
    expect(captured.mounts).toBe(1)
  })
})

// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MarkdownPreviewBody } from './MarkdownPreviewBody'
import { useMarkdownPreviewComponents } from './use-markdown-preview-components'
import { useMarkdownPreviewFoundation } from '../surface/use-markdown-preview-foundation'
import { MarkdownPreviewAnnotationContext } from '../review/markdown-preview-annotation-context'
import { getMarkdownPreviewBlockRange } from '../review/markdown-preview-block-model'
import type { MarkdownPreviewAnnotationRenderers } from '../review/use-markdown-preview-annotation-renderers'
import type { MarkdownPreviewBlockRange } from './markdown-preview-types'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const FILE_PATH = '/repo/notes.md'
const CONTENT = 'First paragraph.\n\n- list item\n'
const NO_DOCUMENTS: never[] = []
const scrollToAnchor = (): boolean => false

function annotationsWithActiveBlock(
  activeBlockKey: string | null
): MarkdownPreviewAnnotationRenderers {
  const renderAnnotationControls = (
    _range: MarkdownPreviewBlockRange,
    blockKey: string
  ): React.ReactNode => (
    <span data-controls-for={blockKey}>{activeBlockKey === blockKey ? 'open' : 'closed'}</span>
  )
  return {
    renderAnnotationControls,
    wrapAnnotatedBlock: (tagName, node, rendered) => {
      const range = getMarkdownPreviewBlockRange(node)
      if (!range) {
        return rendered
      }
      return (
        <div>
          {rendered}
          {renderAnnotationControls(range, `${tagName}:${range.startLine}-${range.endLine}`)}
        </div>
      )
    },
    getMarkdownCommentsForRange: () => [],
    handleAnnotatedMarkdownBlockClick: () => {}
  }
}

function Preview({
  annotations
}: {
  annotations: MarkdownPreviewAnnotationRenderers
}): React.JSX.Element {
  const foundation = useMarkdownPreviewFoundation({
    content: CONTENT,
    filePath: FILE_PATH,
    sourceFileId: null,
    sourceWorktreeId: null,
    sourceRuntimeEnvironmentId: undefined,
    showTableOfContents: false,
    markdownDocuments: NO_DOCUMENTS,
    markdownAnnotationsEnabled: true
  })
  const components = useMarkdownPreviewComponents({
    foundation,
    viewport: { scrollToAnchor },
    filePath: FILE_PATH
  })
  return (
    <MarkdownPreviewAnnotationContext value={annotations}>
      <MarkdownPreviewBody content={CONTENT} components={components} />
    </MarkdownPreviewAnnotationContext>
  )
}

describe('useMarkdownPreviewComponents', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('keeps preview blocks mounted when review-note state changes', () => {
    act(() => root.render(<Preview annotations={annotationsWithActiveBlock(null)} />))
    const paragraph = container.querySelector('p')
    const listItem = container.querySelector('li')
    expect(paragraph).not.toBeNull()
    expect(listItem).not.toBeNull()

    act(() => root.render(<Preview annotations={annotationsWithActiveBlock('p:1-1')} />))

    expect(paragraph?.isConnected).toBe(true)
    expect(listItem?.isConnected).toBe(true)
    expect(container.querySelector('p')).toBe(paragraph)
    expect(container.querySelector('li')).toBe(listItem)
    expect(container.querySelector('[data-controls-for="p:1-1"]')?.textContent).toBe('open')
  })
})

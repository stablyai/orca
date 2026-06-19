// @vitest-environment happy-dom
import { Suspense } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { DiffViewerProps } from './diff-viewer-props'
import {
  MAX_RENDERED_DIFF_COMBINED_CHARACTERS,
  MAX_RENDERED_DIFF_LINES_PER_SIDE,
  type LargeDiffRenderLimit
} from './large-diff-render-limit'

const diffViewerMock = vi.hoisted(() => ({
  latestProps: null as DiffViewerProps | null
}))

vi.mock('./DiffViewer', () => ({
  default: (props: DiffViewerProps) => {
    diffViewerMock.latestProps = props
    return <div data-testid="diff-viewer-probe" />
  }
}))

import { ChangesModeView } from './ChangesModeView'

function createOpenFile(): OpenFile {
  return {
    id: 'file-1',
    filePath: '/repo/large.txt',
    relativePath: 'large.txt',
    worktreeId: 'repo::/repo',
    language: 'plaintext',
    isDirty: false,
    mode: 'edit'
  } as OpenFile
}

function createLargeDiffRenderLimit(): LargeDiffRenderLimit {
  return {
    limited: true,
    reason: 'character-count',
    lineCounts: null,
    characterCount: MAX_RENDERED_DIFF_COMBINED_CHARACTERS + 1,
    limits: {
      maxLinesPerSide: MAX_RENDERED_DIFF_LINES_PER_SIDE,
      maxCombinedCharacters: MAX_RENDERED_DIFF_COMBINED_CHARACTERS
    }
  }
}

describe('ChangesModeView', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    container = null
    root = null
    diffViewerMock.latestProps = null
  })

  it('passes pruned diff limits through and suppresses the identical-content banner', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const largeDiffRenderLimit = createLargeDiffRenderLimit()

    await act(async () => {
      root?.render(
        <Suspense fallback={null}>
          <ChangesModeView
            activeFile={createOpenFile()}
            dc={{
              kind: 'text',
              originalContent: '',
              modifiedContent: '',
              originalIsBinary: false,
              modifiedIsBinary: false,
              largeDiffRenderLimit
            }}
            modifiedContent=""
            activeConflictEntry={null}
            resolvedLanguage="plaintext"
            sideBySide={false}
            viewStateScopeId="file-1"
            diffViewStateKey="file-1:changes"
            onContentChange={vi.fn()}
            onSave={vi.fn()}
          />
        </Suspense>
      )
    })

    await vi.waitFor(() => expect(diffViewerMock.latestProps).not.toBeNull())
    expect(diffViewerMock.latestProps?.largeDiffRenderLimit).toBe(largeDiffRenderLimit)
    expect(container.textContent).not.toContain('No uncommitted changes.')
  })
})

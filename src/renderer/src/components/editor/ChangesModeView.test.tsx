// @vitest-environment happy-dom
import { act, Suspense, useEffect } from 'react'
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
  latestProps: null as DiffViewerProps | null,
  events: [] as string[],
  models: new Map<string, { content: string; undo: string[] }>()
}))

vi.mock('./DiffViewer', () => ({
  default: function MockDiffViewer(props: DiffViewerProps) {
    diffViewerMock.latestProps = props
    const modelKey = props.modifiedModelKey ?? props.modelKey
    const model = diffViewerMock.models.get(modelKey) ?? {
      content: props.modifiedContent,
      undo: []
    }
    if (model.content !== props.modifiedContent) {
      model.undo.push(model.content)
      model.content = props.modifiedContent
    }
    diffViewerMock.models.set(modelKey, model)
    useEffect(() => {
      diffViewerMock.events.push(`mount:${modelKey}`)
      return () => {
        diffViewerMock.events.push(`unmount:${modelKey}`)
      }
    }, [modelKey])
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
    diffViewerMock.events.length = 0
    diffViewerMock.models.clear()
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

  it('rotates the modified model only for an explicit external reload', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const diff = {
      kind: 'text' as const,
      originalContent: 'head',
      modifiedContent: 'worktree',
      originalIsBinary: false as const,
      modifiedIsBinary: false as const
    }

    await act(async () => {
      root?.render(
        <Suspense fallback={null}>
          <ChangesModeView
            activeFile={{ ...createOpenFile(), diffContentReloadNonce: 1 }}
            dc={diff}
            modifiedContent="worktree"
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
    expect(diffViewerMock.latestProps?.modifiedModelKey).toBe('file-1:changes:modified:1')
  })

  it('keeps the modified model and undo history across a changes-mode save', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    const activeFile = createOpenFile()
    const renderView = (modifiedContent: string): void => {
      root?.render(
        <Suspense fallback={null}>
          <ChangesModeView
            activeFile={activeFile}
            dc={{
              kind: 'text',
              originalContent: 'head',
              modifiedContent,
              originalIsBinary: false,
              modifiedIsBinary: false
            }}
            modifiedContent={modifiedContent}
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
    }

    await act(async () => renderView('initial content'))
    const modelKey = diffViewerMock.latestProps?.modifiedModelKey
    const model = modelKey ? diffViewerMock.models.get(modelKey) : undefined
    if (!modelKey || !model) {
      throw new Error('expected a changes-mode modified model')
    }
    model.content = 'user edit'
    model.undo.push('initial content')

    await act(async () => renderView('user edit'))

    expect(diffViewerMock.latestProps?.modifiedModelKey).toBe(modelKey)
    expect(diffViewerMock.events).toEqual([`mount:${modelKey}`])
    expect(model).toEqual({ content: 'user edit', undo: ['initial content'] })
  })
})

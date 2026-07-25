// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'

const lifecycle = vi.hoisted(() => ({
  events: [] as string[],
  diffModelKeys: [] as string[],
  models: new Map<string, { content: string; undo: string[] }>(),
  mountedProps: [] as { filePath: string; readOnly?: boolean; liveTail?: boolean }[]
}))

vi.mock('@/lib/lazy-with-retry', async () => {
  const React = await import('react')
  const { syncContentOnMount } = await import('./monaco-content-sync')
  return {
    lazyWithRetry: (factory: () => Promise<unknown>) => {
      if (factory.toString().includes('/DiffViewer.tsx')) {
        return function MockDiffViewer(props: { filePath: string; modifiedModelKey?: string }) {
          lifecycle.diffModelKeys.push(props.modifiedModelKey ?? '')
          /* oxlint-disable react-hooks/exhaustive-deps -- Mount-only by design: a prop-effect would hide a missing outer React remount. */
          React.useEffect(() => {
            lifecycle.events.push(`mount-diff:${props.filePath}`)
            return () => {
              lifecycle.events.push(`unmount-diff:${props.filePath}`)
            }
          }, [])
          /* oxlint-enable react-hooks/exhaustive-deps */
          return null
        }
      }
      if (!factory.toString().includes('/MonacoEditor.tsx')) {
        return () => null
      }
      return function MockRetainedMonaco(props: {
        filePath: string
        content: string
        readOnly?: boolean
        liveTail?: boolean
      }) {
        /* oxlint-disable react-hooks/exhaustive-deps -- Mount-only by design: a prop-effect would hide a missing outer React remount. */
        React.useEffect(() => {
          lifecycle.events.push(`mount:${props.filePath}`)
          lifecycle.mountedProps.push({
            filePath: props.filePath,
            readOnly: props.readOnly,
            liveTail: props.liveTail
          })
          const retained = lifecycle.models.get(props.filePath) ?? { content: '', undo: [] }
          const model = {
            getValue: () => retained.content,
            getEOL: () => '\n',
            getFullModelRange: () => ({
              startLineNumber: 1,
              startColumn: 1,
              endLineNumber: 1,
              endColumn: retained.content.length + 1
            }),
            pushEditOperations: (_selections: unknown[], operations: { text: string }[]) => {
              retained.content = operations[0]?.text ?? retained.content
            }
          }
          // Why: exercising the real mount reconciler makes outer key ordering
          // observable without replacing Monaco's retained-model semantics.
          syncContentOnMount(
            {
              getModel: () => model,
              pushUndoStop: () => {
                retained.undo.push('unexpected undo stop')
                return true
              }
            } as never,
            props.content
          )
          lifecycle.models.set(props.filePath, retained)
          return () => {
            lifecycle.events.push(`unmount:${props.filePath}`)
          }
        }, [])
        /* oxlint-enable react-hooks/exhaustive-deps */
        return null
      }
    }
  }
})
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        worktreesByRepo: {},
        openFile: vi.fn(),
        openMarkdownPreview: vi.fn(),
        openConflictReviewFile: vi.fn(),
        openConflictReview: vi.fn(),
        closeFile: vi.fn(),
        setRightSidebarTab: vi.fn(),
        setPendingEditorReveal: vi.fn(),
        reloadOpenCheckRunDetailsTab: vi.fn()
      }),
    {
      getState: () => ({
        folderWorkspaces: [],
        projectGroups: [],
        repos: [],
        settings: {},
        worktreesByRepo: {},
        openFile: vi.fn(),
        openMarkdownPreview: vi.fn(),
        openConflictReviewFile: vi.fn(),
        openConflictReview: vi.fn(),
        closeFile: vi.fn(),
        setRightSidebarTab: vi.fn(),
        setPendingEditorReveal: vi.fn(),
        reloadOpenCheckRunDetailsTab: vi.fn()
      })
    }
  )
}))

import { EditorContent } from './EditorContent'

function file(filePath: string, overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: filePath,
    filePath,
    relativePath: filePath.split('/').at(-1) ?? filePath,
    worktreeId: 'repo::/repo',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

function props(activeFile: OpenFile, content: string) {
  return {
    activeFile,
    viewStateScopeId: 'same-pane',
    fileContents: { [activeFile.id]: { content, isBinary: false } },
    diffContents: {},
    editBuffers: {},
    openFiles: [activeFile],
    worktreeEntries: [],
    resolvedLanguage: 'typescript',
    isMarkdown: false,
    isMermaid: false,
    isCsv: false,
    isNotebook: false,
    mdViewMode: 'rich' as const,
    isChangesMode: false,
    sideBySide: false,
    pendingEditorReveal: null,
    handleContentChange: vi.fn(),
    handleContentChangeForFile: vi.fn(),
    handleDirtyStateHint: vi.fn(),
    handleSave: vi.fn(),
    handleSaveForFile: vi.fn(),
    reloadContent: vi.fn()
  }
}

function diffProps(activeFile: OpenFile, modifiedContent: string) {
  return {
    ...props(activeFile, ''),
    diffContents: {
      [activeFile.id]: {
        kind: 'text' as const,
        originalContent: '',
        modifiedContent,
        originalIsBinary: false as const,
        modifiedIsBinary: false as const
      }
    }
  }
}

afterEach(() => {
  cleanup()
  lifecycle.events.length = 0
  lifecycle.diffModelKeys.length = 0
  lifecycle.models.clear()
  lifecycle.mountedProps.length = 0
})

describe('EditorContent Monaco lifecycle boundary', () => {
  it('unmounts the prior path before reconciling a stale retained target model', () => {
    const first = file('/repo/first.ts')
    const second = file('/repo/second.ts')
    lifecycle.models.set(first.filePath, { content: 'first with edits', undo: ['first undo'] })
    lifecycle.models.set(second.filePath, { content: 'stale second', undo: ['second undo'] })
    const view = render(<EditorContent {...props(first, 'first with edits')} />)

    view.rerender(<EditorContent {...props(second, 'fresh second')} />)

    expect(lifecycle.events).toEqual([
      'mount:/repo/first.ts',
      'unmount:/repo/first.ts',
      'mount:/repo/second.ts'
    ])
    expect(lifecycle.models.get(second.filePath)).toEqual({
      content: 'fresh second',
      undo: ['second undo']
    })
    expect(lifecycle.models.get(first.filePath)).toEqual({
      content: 'first with edits',
      undo: ['first undo']
    })
  })

  it('keeps the diff editor mounted when a save updates the modified content', () => {
    // Why: saves must rotate the retained model for freshness without remounting
    // the editor and flashing Monaco's loading placeholder.
    const diff = file('/repo/notes.ts', { mode: 'diff', diffSource: 'unstaged' })

    const view = render(<EditorContent {...diffProps(diff, 'first save')} />)
    view.rerender(<EditorContent {...diffProps(diff, 'second save')} />)

    expect(lifecycle.events).toEqual(['mount-diff:/repo/notes.ts'])
    expect(lifecycle.diffModelKeys).toHaveLength(2)
    expect(lifecycle.diffModelKeys[1]).not.toBe(lifecycle.diffModelKeys[0])
  })

  it('still remounts the diff editor for an explicit reload request', () => {
    const diff = file('/repo/notes.ts', { mode: 'diff', diffSource: 'unstaged' })
    const view = render(<EditorContent {...diffProps(diff, 'saved content')} />)

    view.rerender(
      <EditorContent {...diffProps({ ...diff, diffContentReloadNonce: 1 }, 'saved content')} />
    )

    expect(lifecycle.events).toEqual([
      'mount-diff:/repo/notes.ts',
      'unmount-diff:/repo/notes.ts',
      'mount-diff:/repo/notes.ts'
    ])
  })

  it('passes live-tail ownership only for a read-only live log', () => {
    const liveLog = file('/repo/session.jsonl', { readOnly: true, liveTail: true })

    render(<EditorContent {...props(liveLog, 'session content')} />)

    expect(lifecycle.mountedProps).toEqual([
      { filePath: liveLog.filePath, readOnly: true, liveTail: true }
    ])
  })
})

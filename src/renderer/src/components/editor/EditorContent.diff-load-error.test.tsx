// @vitest-environment happy-dom
// Why: a failed diff load renders the error text as the modified body. If that pane stays editable
// the save path writes it over the real file, because attemptEditorFileSave falls back to the body
// shown when no draft exists.
import { cleanup, render, type RenderResult } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { DiffContent } from './editor-panel-content-types'

const captured = vi.hoisted(() => ({
  diffProps: [] as {
    editable?: boolean
    onSave?: unknown
    onContentChange?: unknown
    modifiedContent?: string
  }[],
  // Why: one entry per DiffViewer instance, so the tests can tell a remount from an in-place prop change.
  mountEvents: [] as string[],
  mountCount: 0
}))

vi.mock('@/lib/lazy-with-retry', async () => {
  const { useEffect } = await import('react')
  return {
    lazyWithRetry: (factory: () => Promise<unknown>) => {
      if (factory.toString().includes('/DiffViewer.tsx')) {
        return function MockDiffViewer(props: {
          editable?: boolean
          onSave?: unknown
          onContentChange?: unknown
          modifiedContent?: string
        }) {
          captured.diffProps.push(props)
          useEffect(() => {
            const id = ++captured.mountCount
            captured.mountEvents.push(`mount:${id}`)
            return () => {
              captured.mountEvents.push(`unmount:${id}`)
            }
          }, [])
          return null
        }
      }
      return () => null
    }
  }
})

vi.mock('@/store', () => {
  const state = {
    worktreesByRepo: {},
    openFile: vi.fn(),
    openMarkdownPreview: vi.fn(),
    openConflictReviewFile: vi.fn(),
    openConflictReview: vi.fn(),
    closeFile: vi.fn(),
    setRightSidebarTab: vi.fn(),
    setPendingEditorReveal: vi.fn(),
    reloadOpenCheckRunDetailsTab: vi.fn()
  }
  return {
    useAppStore: Object.assign(
      (selector: (s: Record<string, unknown>) => unknown) => selector(state),
      { getState: () => ({ ...state, folderWorkspaces: [], projectGroups: [], repos: [] }) }
    )
  }
})

import { EditorContent } from './EditorContent'

const ACTIVE_FILE: OpenFile = {
  id: '/repo/notes.ts',
  filePath: '/repo/notes.ts',
  relativePath: 'notes.ts',
  worktreeId: 'repo::/repo',
  language: 'typescript',
  isDirty: false,
  mode: 'diff',
  diffSource: 'unstaged'
}

function diffElement(
  diff: DiffContent,
  editBuffers: Record<string, string> = {}
): React.JSX.Element {
  return (
    <EditorContent
      activeFile={ACTIVE_FILE}
      viewStateScopeId={ACTIVE_FILE.id}
      fileContents={{}}
      diffContents={{ [ACTIVE_FILE.id]: diff }}
      editBuffers={editBuffers}
      openFiles={[ACTIVE_FILE]}
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
}

function renderDiff(diff: DiffContent, editBuffers: Record<string, string> = {}): RenderResult {
  return render(diffElement(diff, editBuffers))
}

function textDiff(modifiedContent: string, loadError?: boolean): DiffContent {
  return {
    kind: 'text',
    originalContent: '',
    modifiedContent,
    originalIsBinary: false,
    modifiedIsBinary: false,
    ...(loadError === undefined ? {} : { loadError })
  }
}

afterEach(() => {
  cleanup()
  captured.diffProps.length = 0
  captured.mountEvents.length = 0
  captured.mountCount = 0
})

describe('EditorContent diff load failures', () => {
  it('keeps a failed diff load read-only so its message cannot be saved over the file', () => {
    renderDiff(textDiff('Error loading diff: RuntimeRpcCallError: too large', true))

    const props = captured.diffProps.at(-1)
    expect(props?.editable).toBe(false)
    expect(props?.onSave).toBeUndefined()
    // Why: no draft can be minted either, or the next save would write the typed-over message.
    expect(props?.onContentChange).toBeUndefined()
  })

  it('keeps an existing draft editable and saveable when a refetch fails under it', () => {
    // Why: the draft, not the error text, is what renders — locking it would strand unsaved work.
    renderDiff(textDiff('Error loading diff: RuntimeRpcCallError: too large', true), {
      [ACTIVE_FILE.id]: 'export const drafted = 1\n'
    })

    const props = captured.diffProps.at(-1)
    expect(props?.modifiedContent).toBe('export const drafted = 1\n')
    expect(props?.editable).toBe(true)
    expect(props?.onSave).toBeTypeOf('function')
  })

  it('keeps the same viewer instance when a recovered refetch makes the live pane editable again', () => {
    // Why: the recovery is unattended (git-status or external-change refetch), so remounting would
    // re-run DiffViewer's mount-time focus grab and steal keystrokes; DiffViewer re-wires in place instead.
    const { rerender } = renderDiff(
      textDiff('Error loading diff: RuntimeRpcCallError: too large', true)
    )
    expect(captured.diffProps.at(-1)?.editable).toBe(false)
    expect(captured.mountEvents).toEqual(['mount:1'])

    rerender(diffElement(textDiff('export const a = 1\n')))

    expect(captured.diffProps.at(-1)?.editable).toBe(true)
    expect(captured.mountEvents).toEqual(['mount:1'])
  })

  it('keeps the same viewer instance when a refetch only changes the content', () => {
    // Why: guards the remount key against churning Monaco (and its undo stack) on every content refresh.
    const { rerender } = renderDiff(textDiff('export const a = 1\n'))

    rerender(diffElement(textDiff('export const a = 2\n')))

    expect(captured.mountEvents).toEqual(['mount:1'])
  })

  it('leaves a normally loaded unstaged diff editable', () => {
    renderDiff(textDiff('export const a = 1\n'))

    const props = captured.diffProps.at(-1)
    expect(props?.editable).toBe(true)
    expect(props?.onSave).toBeTypeOf('function')
  })
})

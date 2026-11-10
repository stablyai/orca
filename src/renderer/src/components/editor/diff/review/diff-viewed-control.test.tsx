import { useDiffReviewReadInvalidation } from './use-diff-review-read-invalidation'
// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  renderHook,
  render as renderComponent,
  screen
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { DiffContent } from '../../editor-panel-content-types'
import { getEditorFileReadContext } from '@/lib/editor/file-operations/editor-file-operation-owner'
import {
  diffReviewKey,
  diffReviewOwnerKey,
  getReviewedDiffs,
  setDiffReviewed
} from '@/lib/editor/diff-reviewed-files'
import { diffReviewListKey, registerDiffReviewList } from '@/lib/editor/diff-review-navigation'
import type * as RuntimeFileMetadata from '@/runtime/files/metadata/runtime-file-metadata-client'
import { DiffViewedControl } from './diff-viewed-control'
import { TooltipProvider } from '@/components/ui/tooltip'

const render = (ui: React.ReactElement) => renderComponent(ui, { wrapper: TooltipProvider })

const { stat } = vi.hoisted(() => ({ stat: vi.fn() }))
vi.mock('@/runtime/files/metadata/runtime-file-metadata-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeFileMetadata>()),
  statRuntimePath: stat
}))

const file: OpenFile = {
  id: 'review-a',
  worktreeId: 'wt-1',
  filePath: '/repo/a.ts',
  relativePath: 'a.ts',
  mode: 'diff',
  diffSource: 'unstaged',
  runtimeEnvironmentId: null,
  language: 'typescript',
  isDirty: false
}
const content: DiffContent = {
  kind: 'text',
  originalContent: 'before',
  modifiedContent: 'after',
  originalIsBinary: false,
  modifiedIsBinary: false,
  reviewModifiedTime: 123
}
let unregister: (() => void) | undefined

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeWorktreeId: 'wt-1',
    activeFileId: file.id,
    repos: [
      { id: 'repo', path: '/repo', displayName: 'repo', badgeColor: '', addedAt: 1, kind: 'git' }
    ],
    worktreesByRepo: { repo: [makeWorktree({ id: 'wt-1', repoId: 'repo', path: '/repo' })] },
    openFiles: [file]
  })
  for (const key of getReviewedDiffs().keys()) {
    setDiffReviewed(key, null)
  }
  stat.mockReset().mockResolvedValue({ mtime: 123, size: 5, isDirectory: false })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  unregister?.()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

function registerFilteredList(onOpen: (path: string) => void): void {
  const owner = getEditorFileReadContext(useAppStore.getState(), file, '/repo')
  unregister = registerDiffReviewList(
    diffReviewListKey(diffReviewOwnerKey(owner), 'unstaged'),
    ['a.ts', 'c.ts'].map((path) => ({
      key: diffReviewKey(owner, path, 'unstaged'),
      entrySignature: '["modified",null,1,1]',
      open: () => onOpen(path)
    }))
  )
}

describe('single-file diff Viewed', () => {
  it.each([
    ['Macintosh', { ctrlKey: true }],
    ['Windows', { key: 'v', altKey: true, shiftKey: true }],
    ['Linux', { key: 'v', altKey: true, shiftKey: true }]
  ])('toggles Viewed from the focused diff on %s', async (userAgent, modifiers) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
    const opened: string[] = []
    registerFilteredList((path) => opened.push(path))
    render(
      <div data-editor-panel>
        <div className="monaco-editor">
          <textarea className="inputarea" aria-label="Diff" />
        </div>
        <DiffViewedControl file={file} content={content} />
      </div>
    )
    const target = screen.getByRole('textbox', { name: 'Diff' })
    await act(async () => fireEvent.keyDown(target, { key: 'v', ...modifiers }))
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('true')
    expect(opened).toEqual(['c.ts'])
    await act(async () => fireEvent.keyDown(target, { key: 'v', ...modifiers }))
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false')
    expect(opened).toEqual(['c.ts'])
  })

  it('uses remapped keys only in its diff and preserves text entry and held keys', async () => {
    useAppStore.setState({ keybindings: { 'editor.toggleViewed': ['Alt+Shift+X'] } })
    const opened: string[] = []
    registerFilteredList((path) => opened.push(path))
    render(
      <>
        <button>Other pane</button>
        <div data-editor-panel>
          <input aria-label="Review note" />
          <DiffViewedControl file={file} content={content} />
        </div>
      </>
    )
    const chord = { key: 'x', altKey: true, shiftKey: true }
    fireEvent.keyDown(screen.getByRole('button', { name: 'Other pane' }), chord)
    fireEvent.keyDown(screen.getByRole('textbox'), chord)
    const checkbox = screen.getByRole('checkbox')
    fireEvent.keyDown(checkbox, { ...chord, repeat: true })
    expect(checkbox.getAttribute('aria-checked')).toBe('false')
    expect(opened).toEqual([])
    await act(async () => fireEvent.keyDown(checkbox, chord))
    expect(checkbox.getAttribute('aria-checked')).toBe('true')
    expect(opened).toEqual(['c.ts'])
  })

  it('marks and advances within the filtered list, restores across remount, and unmarks without navigating', async () => {
    const opened: string[] = []
    registerFilteredList((path) => opened.push(path))
    const view = render(<DiffViewedControl file={file} content={content} />)
    await act(async () => fireEvent.click(screen.getByRole('checkbox')))
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('true')
    expect(opened).toEqual(['c.ts'])
    view.unmount()
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'orca.reviewed-diffs.v1' })))
    render(<DiffViewedControl file={file} content={content} />)
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('true')
    await act(async () => fireEvent.click(screen.getByRole('checkbox')))
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false')
    expect(opened).toEqual(['c.ts'])
  })

  it('clears review when fetched diff content changes even with the same modification time', async () => {
    const view = render(<DiffViewedControl file={file} content={content} />)
    await act(async () => fireEvent.click(screen.getByRole('checkbox')))
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('true')
    view.rerender(
      <DiffViewedControl file={file} content={{ ...content, modifiedContent: 'other' }} />
    )
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false')
  })

  it('invalidates a changed read once a dirty section becomes clean', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    const key = 'dirty-read'
    const record = {
      viewedAt: 1_800_000_000_000,
      modifiedTime: 123,
      contentSignature: 'before',
      entrySignature: ''
    }
    setDiffReviewed(key, record)
    const view = renderHook(
      ({ signature, valid }) =>
        useDiffReviewReadInvalidation({
          key,
          record,
          signature,
          valid,
          modifiedTime: 123
        }),
      { initialProps: { signature: 'before', valid: true } }
    )
    view.rerender({ signature: 'after', valid: false })
    expect(getReviewedDiffs().has(key)).toBe(true)
    view.rerender({ signature: 'after', valid: true })
    expect(getReviewedDiffs().has(key)).toBe(false)
  })

  it('advances using status entries when the filtered list omits the current file', async () => {
    const owner = getEditorFileReadContext(useAppStore.getState(), file, '/repo')
    unregister = registerDiffReviewList(diffReviewListKey(diffReviewOwnerKey(owner), 'unstaged'), [
      {
        key: diffReviewKey(owner, 'c.ts', 'unstaged'),
        entrySignature: '',
        open: vi.fn()
      }
    ])
    const openDiff = vi.fn()
    useAppStore.setState({
      openDiff,
      gitStatusByWorktree: {
        'wt-1': ['a.ts', 'b.ts'].map((path) => ({
          path,
          area: 'unstaged' as const,
          status: 'modified' as const,
          added: 1,
          removed: 1
        }))
      }
    })
    render(<DiffViewedControl file={file} content={content} />)
    await act(async () => fireEvent.click(screen.getByRole('checkbox')))
    expect(openDiff).toHaveBeenCalledWith(
      'wt-1',
      '/repo/b.ts',
      'b.ts',
      'typescript',
      false,
      expect.any(Object)
    )
  })

  it('hides an existing mark while content is stale or failed', async () => {
    const view = render(<DiffViewedControl file={file} content={content} />)
    await act(async () => fireEvent.click(screen.getByRole('checkbox')))
    view.rerender(<DiffViewedControl file={file} content={{ ...content, isStale: true }} />)
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false')
    view.rerender(<DiffViewedControl file={file} content={{ ...content, loadError: true }} />)
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false')
  })

  it('does not mark stale bytes when disk contents changed since loading the diff', async () => {
    stat.mockResolvedValue({ mtime: 124, size: 5, isDirectory: false })
    const opened: string[] = []
    registerFilteredList((path) => opened.push(path))
    render(<DiffViewedControl file={file} content={content} />)
    await act(async () => fireEvent.click(screen.getByRole('checkbox')))
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false')
    expect(opened).toEqual([])
  })

  it('does not mark or navigate if the file becomes dirty during verification', async () => {
    let finish!: (value: { mtime: number }) => void
    stat.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const opened: string[] = []
    registerFilteredList((path) => opened.push(path))
    render(<DiffViewedControl file={file} content={content} />)
    fireEvent.click(screen.getByRole('checkbox'))
    act(() => useAppStore.getState().markFileDirty(file.id, true))
    await act(async () => finish({ mtime: 123 }))
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false')
    expect(opened).toEqual([])
  })
  it('keeps the newly selected file when verification finishes after a tab switch', async () => {
    let finish!: (value: { mtime: number }) => void
    stat.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const opened: string[] = []
    registerFilteredList((path) => opened.push(path))
    render(<DiffViewedControl file={file} content={content} />)
    fireEvent.click(screen.getByRole('checkbox'))
    act(() => useAppStore.setState({ activeFileId: 'different-file' }))
    await act(async () => finish({ mtime: 123 }))
    expect(opened).toEqual([])
  })
})

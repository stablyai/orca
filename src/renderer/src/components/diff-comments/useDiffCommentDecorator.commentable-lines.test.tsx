// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { editor as MonacoEditor, IDisposable } from 'monaco-editor'
import type { DecoratedDiffComment } from './decorated-diff-comment'
import type * as ReactDomClientModule from 'react-dom/client'
import type * as DiffCommentZoneCardModule from './diff-comment-zone-card'

const storeFixture = vi.hoisted(() => ({
  activeGroupIdByWorktree: {},
  clearDeliveredDiffComments: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeFixture) => unknown) => selector(storeFixture)
}))

// Stub only the card render: this suite is about zone/root lifecycle, not card markup.
vi.mock('./diff-comment-zone-card', async (importOriginal) => ({
  ...(await importOriginal<typeof DiffCommentZoneCardModule>()),
  renderDiffCommentZoneCard: vi.fn()
}))

const rootCounts = vi.hoisted(() => ({ created: 0, unmounted: 0 }))

// Count only roots the decorator creates for its zones — @testing-library/react creates its own.
vi.mock('react-dom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactDomClientModule>()
  return {
    ...actual,
    createRoot: (container: Element, options?: Parameters<typeof actual.createRoot>[1]) => {
      const isZoneRoot = container.classList?.contains('orca-diff-comment-inline') ?? false
      if (isZoneRoot) {
        rootCounts.created += 1
      }
      const root = actual.createRoot(container, options)
      return {
        render: (node: Parameters<typeof root.render>[0]) => root.render(node),
        unmount: () => {
          if (isZoneRoot) {
            rootCounts.unmounted += 1
          }
          root.unmount()
        }
      }
    }
  }
})

import { useDiffCommentDecorator } from './useDiffCommentDecorator'

type FakeEditor = {
  editor: MonacoEditor.ICodeEditor
  domNode: HTMLElement
  zones: Map<string, MonacoEditor.IViewZone>
  emitMouseMove: (lineNumber: number) => void
}

function createFakeEditor(): FakeEditor {
  const domNode = document.createElement('div')
  document.body.appendChild(domNode)
  const zones = new Map<string, MonacoEditor.IViewZone>()
  let nextZoneId = 0
  const mouseMoveListeners: ((e: { target: { position: { lineNumber: number } } }) => void)[] = []
  const noopDisposable: IDisposable = { dispose: () => {} }

  const editor = {
    getDomNode: () => domNode,
    getModel: () => ({}),
    getOption: () => 19,
    getTopForLineNumber: () => 0,
    getScrollTop: () => 0,
    getLayoutInfo: () => ({ height: 400 }),
    setScrollTop: () => {},
    deltaDecorations: () => [],
    getTargetAtClientPoint: () => null,
    onMouseMove: (listener: (e: { target: { position: { lineNumber: number } } }) => void) => {
      mouseMoveListeners.push(listener)
      return noopDisposable
    },
    onMouseLeave: () => noopDisposable,
    onDidScrollChange: () => noopDisposable,
    changeViewZones: (callback: (accessor: MonacoEditor.IViewZoneChangeAccessor) => void) =>
      callback({
        addZone: (zone: MonacoEditor.IViewZone) => {
          const id = `zone-${(nextZoneId += 1)}`
          zones.set(id, zone)
          return id
        },
        removeZone: (id: string) => {
          zones.delete(id)
        },
        layoutZone: () => {}
      } as unknown as MonacoEditor.IViewZoneChangeAccessor)
  } as unknown as MonacoEditor.ICodeEditor

  return {
    editor,
    domNode,
    zones,
    emitMouseMove: (lineNumber) => {
      for (const listener of mouseMoveListeners) {
        listener({ target: { position: { lineNumber } } })
      }
    }
  }
}

const FILE_PATH = 'src/index.ts'
const REVIEW_SURFACE_ID = 'pr:acme/widgets:42'

function reviewNote(index: number): DecoratedDiffComment {
  return {
    id: `review-note-${index}`,
    worktreeId: REVIEW_SURFACE_ID,
    filePath: FILE_PATH,
    lineNumber: 10 + index,
    body: `Please rename this (${index}).`,
    createdAt: index,
    side: 'modified',
    author: 'octocat'
  }
}

// Every refresh of remote review data yields a fresh-but-equal array, exactly as the main process ships it.
function freshCommentableLines(): readonly number[] {
  return [10, 11, 12, 13, 14, 15, 16]
}

// Root teardown is deferred through queueMicrotask, so drain before asserting on unmount counts.
async function flushDeferredUnmounts(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

// Asserted as one object so a failure reports every lifecycle number at once.
function lifecycleTotals(fake: FakeEditor): Record<string, number> {
  return {
    createRootCalls: rootCounts.created,
    rootUnmounts: rootCounts.unmounted,
    monacoViewZones: fake.zones.size
  }
}

function isAddButtonVisible(domNode: HTMLElement): boolean {
  const button = domNode.querySelector<HTMLElement>('.orca-diff-comment-add-btn')
  return button != null && button.style.display !== 'none'
}

type DecoratorProps = {
  commentableLineNumbers: readonly number[]
  comments: readonly DecoratedDiffComment[]
}

function renderDecorator(fake: FakeEditor, initialProps: DecoratorProps) {
  return renderHook(
    ({ commentableLineNumbers, comments }: DecoratorProps) =>
      useDiffCommentDecorator({
        editor: fake.editor,
        filePath: FILE_PATH,
        worktreeId: REVIEW_SURFACE_ID,
        comments,
        commentableLineNumbers,
        onAddCommentClick: vi.fn(),
        onDeleteComment: vi.fn()
      }),
    { initialProps }
  )
}

beforeEach(() => {
  rootCounts.created = 0
  rootCounts.unmounted = 0
})

afterEach(() => {
  document.body.replaceChildren()
  vi.clearAllMocks()
})

function countingCommentableLines(length: number): {
  lines: readonly number[]
  joins: () => number
} {
  const lines = Array.from({ length }, (_, index) => index + 1)
  let joins = 0
  Object.defineProperty(lines, 'join', {
    configurable: true,
    value: (separator?: string) => {
      joins += 1
      return Array.prototype.join.call(lines, separator)
    }
  })
  return { lines, joins: () => joins }
}

describe('useDiffCommentDecorator commentable-line churn', () => {
  it('joins the commentable-line array once, not once per render, for a stable array', () => {
    const fake = createFakeEditor()
    const comments = [reviewNote(1)]
    // reviewCommentLineNumbers carries every added and context line of the patch.
    const { lines, joins } = countingCommentableLines(4_000)
    const hook = renderDecorator(fake, { commentableLineNumbers: lines, comments })

    for (let render = 1; render < 100; render += 1) {
      hook.rerender({ commentableLineNumbers: lines, comments })
    }

    expect(joins()).toBe(1)
  })

  it('still re-keys on a fresh-but-equal array so the comment set survives a review refresh', () => {
    const fake = createFakeEditor()
    const comments = [reviewNote(1)]
    const hook = renderDecorator(fake, {
      commentableLineNumbers: freshCommentableLines(),
      comments
    })

    fake.emitMouseMove(12)
    expect(isAddButtonVisible(fake.domNode)).toBe(true)

    hook.rerender({ commentableLineNumbers: freshCommentableLines(), comments })

    fake.emitMouseMove(12)
    expect(isAddButtonVisible(fake.domNode)).toBe(true)
    expect(rootCounts.created).toBe(1)
  })

  it('keeps every comment root and view zone alive across value-equal review refreshes', async () => {
    const fake = createFakeEditor()
    const comments = [reviewNote(1), reviewNote(2), reviewNote(3)]
    const hook = renderDecorator(fake, {
      commentableLineNumbers: freshCommentableLines(),
      comments
    })

    expect(rootCounts.created).toBe(3)
    expect(fake.zones.size).toBe(3)

    for (let refresh = 0; refresh < 5; refresh += 1) {
      hook.rerender({ commentableLineNumbers: freshCommentableLines(), comments })
    }
    await flushDeferredUnmounts()

    expect(lifecycleTotals(fake)).toEqual({
      createRootCalls: 3,
      rootUnmounts: 0,
      monacoViewZones: 3
    })

    // Still tracked, so dropping a note reclaims its vertical space instead of leaving a blank gap.
    hook.rerender({ commentableLineNumbers: freshCommentableLines(), comments: comments.slice(1) })
    expect(fake.zones.size).toBe(2)
  })

  it('does not accumulate orphan zones when refreshes interleave with new review comments', async () => {
    const fake = createFakeEditor()
    let comments = [reviewNote(1)]
    const hook = renderDecorator(fake, {
      commentableLineNumbers: freshCommentableLines(),
      comments
    })

    for (let refresh = 2; refresh <= 6; refresh += 1) {
      comments = [...comments, reviewNote(refresh)]
      hook.rerender({ commentableLineNumbers: freshCommentableLines(), comments })
    }
    await flushDeferredUnmounts()

    // 6 live notes => 6 roots, 6 zones, nothing stranded.
    expect(lifecycleTotals(fake)).toEqual({
      createRootCalls: 6,
      rootUnmounts: 0,
      monacoViewZones: 6
    })
  })

  it('rebuilds the add-button overlay when the commentable lines really change', async () => {
    const fake = createFakeEditor()
    const comments = [reviewNote(1)]
    const hook = renderDecorator(fake, {
      commentableLineNumbers: [10, 11, 12] as readonly number[],
      comments
    })

    fake.emitMouseMove(40)
    expect(isAddButtonVisible(fake.domNode)).toBe(false)

    hook.rerender({ commentableLineNumbers: [10, 11, 12, 40], comments })
    await flushDeferredUnmounts()

    // Decorator is not stale: the widened set is live...
    fake.emitMouseMove(40)
    expect(isAddButtonVisible(fake.domNode)).toBe(true)
    // ...and the existing note's zone/root was neither orphaned nor rebuilt.
    expect(lifecycleTotals(fake)).toEqual({
      createRootCalls: 1,
      rootUnmounts: 0,
      monacoViewZones: 1
    })
  })

  it('removes its zones from Monaco when the model swaps under a retained editor', async () => {
    const fake = createFakeEditor()
    const comments = [reviewNote(1)]
    const hook = renderHook(
      ({ monacoModelIdentity }) =>
        useDiffCommentDecorator({
          editor: fake.editor,
          monacoModelIdentity,
          filePath: FILE_PATH,
          worktreeId: REVIEW_SURFACE_ID,
          comments,
          commentableLineNumbers: freshCommentableLines(),
          onAddCommentClick: vi.fn(),
          onDeleteComment: vi.fn()
        }),
      { initialProps: { monacoModelIdentity: 'modified-v1' } }
    )
    const firstZoneIds = [...fake.zones.keys()]

    hook.rerender({ monacoModelIdentity: 'modified-v2' })
    await flushDeferredUnmounts()

    // Stale zone ids are gone rather than left as untracked blank gaps, and the note was rebuilt.
    expect(fake.zones.size).toBe(1)
    expect([...fake.zones.keys()]).not.toEqual(firstZoneIds)
    expect(rootCounts.created).toBe(2)
    expect(rootCounts.unmounted).toBe(1)
  })
})

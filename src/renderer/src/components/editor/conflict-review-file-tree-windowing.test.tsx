// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VIRTUALIZED_LIST_MIN_ROWS, VIRTUALIZED_LIST_OVERSCAN } from '@/components/virtualized-list'
import type {
  GitConflictKind,
  GitConflictResolutionStatus,
  GitStatusEntry
} from '../../../../shared/git-status-types'
import { ConflictReviewFileTree, CONFLICT_REVIEW_ROW_HEIGHT_PX } from './ConflictReviewFileTree'

const VIEWPORT_HEIGHT_PX = 600
const TREE_INDENT_PX = 12
const DIRECTORY_PADDING_PX = 8
const FILE_PADDING_PX = 20
const MERGE_FILE_COUNT = 500
const MERGE_DIRECTORY_COUNT = 10
const FILES_PER_DIRECTORY = MERGE_FILE_COUNT / MERGE_DIRECTORY_COUNT

// happy-dom has no layout, so the viewport and every row height come from the `offsetHeight` and
// `getBoundingClientRect` spies below; `offsetHeight` feeds both virtual-core's viewport rect and
// `measureElement`, while `getBoundingClientRect` is read only by
// `measureVirtualizedListScrollMargin`. The rect spy puts the scroller at `top: 0` and the virtual
// list `MEASURED_SCROLL_MARGIN_PX` into its scrollable content, so the margin this consumer
// measures is the real one rather than an accidental 0.
const ROWS_PER_VIEWPORT = Math.floor(VIEWPORT_HEIGHT_PX / CONFLICT_REVIEW_ROW_HEIGHT_PX)
// The scroller's own `py-1`, which is where the app's 4px offset comes from.
const MEASURED_SCROLL_MARGIN_PX = 4

type ConflictEntry = {
  path: string
  conflictKind: GitConflictKind
  liveEntry?: GitStatusEntry
}

// Pins happy-dom's no-op ResizeObserver: a real one would re-measure the scroll margin mid-test.
class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains('overflow-auto')
        ? VIEWPORT_HEIGHT_PX
        : CONFLICT_REVIEW_ROW_HEIGHT_PX
    }
  )
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const top = synthesizedTop(this)
    const height = this.classList.contains('overflow-auto')
      ? VIEWPORT_HEIGHT_PX
      : CONFLICT_REVIEW_ROW_HEIGHT_PX
    return new DOMRect(0, top, 288, height)
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * Synthetic layout top for the rect spy. Everything sits at 0 except the virtual list, which sits
 * `MEASURED_SCROLL_MARGIN_PX` into the scroller's content: the offset is taken against the
 * scroller's current `scrollTop`, which `measureVirtualizedListScrollMargin` adds back, so a
 * re-measure mid-scroll reports the same margin as the one at mount.
 */
function synthesizedTop(element: Element): number {
  if (!element.matches('[data-testid="virtualized-list"]')) {
    return 0
  }
  const scroller = element.closest('.overflow-auto')
  return MEASURED_SCROLL_MARGIN_PX - (scroller instanceof HTMLElement ? scroller.scrollTop : 0)
}

function directoryName(directoryIndex: number): string {
  return `dir-${String(directoryIndex).padStart(2, '0')}`
}

function filePath(directoryIndex: number, fileIndex: number): string {
  return `src/${directoryName(directoryIndex)}/file-${String(fileIndex).padStart(3, '0')}.ts`
}

// Sorts ahead of every generated `file-NNN.ts`, so inserting it shifts the rest of `dir-00` down.
const INSERTED_FILE_PATH = 'src/dir-00/aaa-inserted.ts'

const DUPLICATE_BASENAME = 'index.ts'
const DUPLICATE_DIRECTORIES = ['dup-a', 'dup-b'] as const
// Padding per directory picks which branch the fixture lands in: 26 projects 57 rows, over the
// virtualize threshold; 1 projects 7 rows, under it.
const DUPLICATE_PADDING_PER_DIRECTORY = 26
const DUPLICATE_SUB_THRESHOLD_PADDING_PER_DIRECTORY = 1
// Sorts ahead of `index.ts`, so inserting it shifts both duplicates down one index.
const DUPLICATE_INSERTED_FILE_PATH = `src/${DUPLICATE_DIRECTORIES[0]}/aaa-inserted.ts`

/**
 * Two directories that each hold an `index.ts`, plus `paddingPerDirectory` uniquely named files.
 * `buildEntries` names every file after its global index, so its basenames are accidentally as
 * unique as its keys; real conflict sets repeat basenames across directories.
 */
function buildDuplicateBasenameEntries(
  paddingPerDirectory: number = DUPLICATE_PADDING_PER_DIRECTORY
): ConflictEntry[] {
  return DUPLICATE_DIRECTORIES.flatMap((directory) => [
    conflictEntry(`src/${directory}/${DUPLICATE_BASENAME}`),
    ...Array.from({ length: paddingPerDirectory }, (_, index) =>
      conflictEntry(`src/${directory}/pad-${String(index).padStart(3, '0')}.ts`)
    )
  ])
}

/**
 * One entry of the conflict snapshot. `liveStatus` is what git reports for it now: `'unresolved'`,
 * `'resolved_locally'`, or `'gone'` for a file that has left git status entirely (no live entry).
 */
function conflictEntry(
  path: string,
  liveStatus: GitConflictResolutionStatus | 'gone' = 'unresolved'
): ConflictEntry {
  return {
    path,
    conflictKind: 'both_modified',
    liveEntry:
      liveStatus === 'gone'
        ? undefined
        : {
            path,
            status: 'modified',
            area: 'unstaged',
            conflictKind: 'both_modified',
            conflictStatus: liveStatus
          }
  }
}

/** `fileCount` conflicted files dealt round-robin into `directoryCount` directories under `src/`. */
function buildEntries(fileCount: number, directoryCount: number): ConflictEntry[] {
  return Array.from({ length: fileCount }, (_, index) =>
    conflictEntry(filePath(index % directoryCount, index))
  )
}

/**
 * The rows `buildConflictReviewRows` projects, as row labels in order: the single `src` directory
 * (nothing compacts, since it has more than one child), then each directory header followed by its
 * files unless it is collapsed. Directory rows are labelled by name, file rows by path.
 */
function buildProjection(
  fileCount: number,
  directoryCount: number,
  collapsedDirectories: ReadonlySet<string> = new Set()
): string[] {
  const labels = ['src']
  for (let directory = 0; directory < directoryCount; directory += 1) {
    labels.push(directoryName(directory))
    if (collapsedDirectories.has(directoryName(directory))) {
      continue
    }
    for (let index = directory; index < fileCount; index += directoryCount) {
      labels.push(filePath(directory, index))
    }
  }
  return labels
}

function renderTree(
  entries: readonly ConflictEntry[],
  options: { selectedPath?: string | null; onOpenEntry?: (entry: GitStatusEntry) => void } = {}
): void {
  act(() => {
    root.render(
      <ConflictReviewFileTree
        entries={entries}
        collapsed={false}
        onCollapsedChange={() => {}}
        selectedPath={options.selectedPath ?? null}
        onOpenEntry={options.onOpenEntry ?? (() => {})}
      />
    )
  })
}

function getScroller(): HTMLElement {
  const scroller = host.querySelector('.overflow-auto')
  if (!(scroller instanceof HTMLElement)) {
    throw new Error('conflict review scroller not found')
  }
  return scroller
}

/** Rows actually in the DOM. Scoped to the scroller because the header also holds a button. */
function getMountedRows(): HTMLButtonElement[] {
  return Array.from(getScroller().querySelectorAll('button'))
}

function getRowLabel(row: HTMLButtonElement): string {
  return row.getAttribute('title') ?? row.querySelector('span')?.textContent ?? ''
}

/** Each windowed row with the projection index its wrapper claims. */
function getMountedWindow(): { index: number; label: string }[] {
  return Array.from(getScroller().querySelectorAll('[data-index]')).map((wrapper) => {
    const row = wrapper.querySelector('button')
    if (!(row instanceof HTMLButtonElement)) {
      throw new Error('windowed wrapper has no row')
    }
    return { index: Number(wrapper.getAttribute('data-index')), label: getRowLabel(row) }
  })
}

/** The `translateY` a windowed wrapper carries, which must be relative to the list, not the scroller. */
function getWrapperTransform(index: number): string {
  const wrapper = getScroller().querySelector(`[data-index="${index}"]`)
  if (!(wrapper instanceof HTMLElement)) {
    throw new Error(`wrapper for index ${index} is not mounted`)
  }
  return wrapper.style.transform
}

/** Every mounted row holds the content its projection index calls for. */
function expectWindowMatchesProjection(projection: readonly string[]): void {
  const mounted = getMountedWindow()
  expect(mounted.length).toBeGreaterThan(0)
  for (const { index, label } of mounted) {
    expect(label).toBe(projection[index])
  }
}

function getVirtualListContainer(): HTMLElement {
  const container = host.querySelector('[data-testid="virtualized-list"]')
  if (!(container instanceof HTMLElement)) {
    throw new Error('virtual list container not found')
  }
  return container
}

/**
 * The range virtual-core resolves: it ends at the first row whose end reaches or passes the
 * viewport bottom, so a partly visible last row is still in range; then
 * `VIRTUALIZED_LIST_OVERSCAN` extends both edges, clamped to the list. Two
 * preconditions: the scroll offset must be row-aligned (a partially scrolled row makes the real
 * range one row longer), and `CONFLICT_REVIEW_ROW_HEIGHT_PX` must divide `VIEWPORT_HEIGHT_PX` — the
 * floor in `ROWS_PER_VIEWPORT` keeps the expectation a whole number, but a row height that leaves a
 * remainder also leaves a partly visible last row that virtual-core still counts as in range.
 */
function expectedWindow(
  startIndex: number,
  totalRows: number
): { first: number; last: number; count: number } {
  const first = Math.max(0, startIndex - VIRTUALIZED_LIST_OVERSCAN)
  const last = Math.min(
    totalRows - 1,
    startIndex + ROWS_PER_VIEWPORT - 1 + VIRTUALIZED_LIST_OVERSCAN
  )
  return { first, last, count: last - first + 1 }
}

/** happy-dom fires no `scroll` event on a `scrollTop` write, so dispatch the one the virtualizer listens for. */
function scrollToIndex(startIndex: number): void {
  const scroller = getScroller()
  scroller.scrollTop = startIndex * CONFLICT_REVIEW_ROW_HEIGHT_PX + MEASURED_SCROLL_MARGIN_PX
  act(() => {
    scroller.dispatchEvent(new Event('scroll'))
  })
}

/** The windowed wrapper around a row, which is what carries React identity across a re-render. */
function getWrapper(label: string): Element {
  const wrapper = Array.from(getScroller().querySelectorAll('[data-index]')).find(
    (candidate) => candidate.querySelector('button')?.getAttribute('title') === label
  )
  if (!wrapper) {
    throw new Error(`row ${label} is not mounted`)
  }
  return wrapper
}

function getRow(label: string): HTMLButtonElement {
  const row = getMountedRows().find((candidate) => getRowLabel(candidate) === label)
  if (!row) {
    throw new Error(`row ${label} is not mounted`)
  }
  return row
}

/** A file row's status badge: the last span, after the name span and the label nested inside it. */
function getRowBadgeText(row: HTMLButtonElement): string {
  return Array.from(row.querySelectorAll('span')).at(-1)?.textContent ?? ''
}

function getSelectedRows(): HTMLButtonElement[] {
  return getMountedRows().filter((row) => row.classList.contains('bg-accent/60'))
}

function clickRow(label: string): void {
  act(() => getRow(label).click())
}

describe('conflict review file tree row windowing', () => {
  it('mounts every row below the virtualize threshold', () => {
    const fileCount = 30
    const directoryCount = 4
    renderTree(buildEntries(fileCount, directoryCount))

    const projection = buildProjection(fileCount, directoryCount)
    expect(projection.length).toBe(1 + directoryCount + fileCount)
    expect(projection.length).toBeLessThan(VIRTUALIZED_LIST_MIN_ROWS)
    expect(getMountedRows().map(getRowLabel)).toEqual(projection)
    expect(host.querySelector('[data-testid="virtualized-list"]')).toBeNull()
    // Natural flow: no absolutely positioned wrappers, exactly the pre-virtualization markup.
    expect(host.querySelectorAll('[data-index]')).toHaveLength(0)
  })

  it('mounts only a bounded window for a 500-file merge', () => {
    renderTree(buildEntries(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT))

    const projection = buildProjection(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT)
    expect(projection.length).toBe(511)
    const window = expectedWindow(0, projection.length)
    expect(window.count).toBe(34)

    expect(getVirtualListContainer().style.height).toBe(
      `${projection.length * CONFLICT_REVIEW_ROW_HEIGHT_PX}px`
    )
    expect(getMountedRows()).toHaveLength(window.count)
    expect(getMountedWindow().map((row) => row.index)).toEqual(
      Array.from({ length: window.count }, (_, offset) => window.first + offset)
    )
    expectWindowMatchesProjection(projection)
    expect(window.count).toBeLessThan(projection.length / 10)

    // `item.start` is scroller-wide, so the wrappers must shed the measured margin again: the first
    // row sits flush at the list's top rather than MEASURED_SCROLL_MARGIN_PX below it.
    scrollToIndex(0)
    expect(getWrapperTransform(0)).toBe('translateY(0px)')
    expect(getWrapperTransform(20)).toBe(`translateY(${20 * CONFLICT_REVIEW_ROW_HEIGHT_PX}px)`)
  })

  it('mounts a two-sided window once scrolled into the middle of the list', () => {
    renderTree(buildEntries(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT))
    const projection = buildProjection(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT)

    scrollToIndex(250)

    const window = expectedWindow(250, projection.length)
    expect(window).toEqual({ first: 240, last: 283, count: 44 })
    expect(getMountedRows()).toHaveLength(window.count)
    expectWindowMatchesProjection(projection)
  })

  it('resolves the window against the list offset inside the scroller', () => {
    renderTree(buildEntries(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT))
    const projection = buildProjection(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT)

    // A raw offset, without the margin `scrollToIndex` adds. The list starts
    // MEASURED_SCROLL_MARGIN_PX down the scroller, so row 250 has not quite reached the top and the
    // resolved window keeps the row above it — a margin measured as 0 would start at 240.
    const scroller = getScroller()
    scroller.scrollTop = 250 * CONFLICT_REVIEW_ROW_HEIGHT_PX
    act(() => {
      scroller.dispatchEvent(new Event('scroll'))
    })

    expect(getMountedWindow()[0]?.index).toBe(250 - VIRTUALIZED_LIST_OVERSCAN - 1)
    expectWindowMatchesProjection(projection)
  })

  it('keeps rows correct and the window bounded across insert and remove', () => {
    const entries = buildEntries(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT)
    const projection = buildProjection(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT)
    renderTree(entries)
    expect(getMountedRows()).toHaveLength(34)

    // Insert: a file that sorts to the front of `dir-00`, so every later row shifts by one.
    renderTree([conflictEntry(INSERTED_FILE_PATH), ...entries])
    const withInserted = [...projection]
    withInserted.splice(2, 0, INSERTED_FILE_PATH)
    expect(getVirtualListContainer().style.height).toBe(
      `${withInserted.length * CONFLICT_REVIEW_ROW_HEIGHT_PX}px`
    )
    expect(getMountedRows()).toHaveLength(34)
    expectWindowMatchesProjection(withInserted)

    // Remove: back to the original set, and the inserted row leaves the window.
    renderTree(entries)
    expect(getMountedRows()).toHaveLength(34)
    expectWindowMatchesProjection(projection)
    expect(getScroller().querySelector(`[title="${INSERTED_FILE_PATH}"]`)).toBeNull()

    // The builder sorts by path, so input order never reaches the window: reversed input projects
    // the same rows. This checks that invariance, not reordering of the projected list.
    renderTree(entries.toReversed())
    expect(getMountedRows()).toHaveLength(34)
    expectWindowMatchesProjection(projection)
  })

  it('carries a row its own DOM node when an insert shifts its index', () => {
    const entries = buildEntries(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT)
    renderTree(entries)

    const trackedPath = filePath(0, 0)
    const before = getWrapper(trackedPath)
    expect(before.getAttribute('data-index')).toBe('2')

    // A file sorting ahead of the tracked one pushes it down an index while both stay in the window.
    // Keys are path-derived, so the tracked row keeps its node instead of inheriting the one that
    // merely sits at its old position.
    renderTree([conflictEntry(INSERTED_FILE_PATH), ...entries])

    const after = getWrapper(trackedPath)
    expect(after.getAttribute('data-index')).toBe('3')
    expect(after).toBe(before)
  })

  it('keeps two files sharing a basename on separate rows with separate nodes', () => {
    const pathA = `src/${DUPLICATE_DIRECTORIES[0]}/${DUPLICATE_BASENAME}`
    const pathB = `src/${DUPLICATE_DIRECTORIES[1]}/${DUPLICATE_BASENAME}`
    renderTree(buildDuplicateBasenameEntries())

    // Both duplicates are inside the window the list opens with, each on its own projection index.
    expect(
      getMountedWindow().filter((row) => row.label.endsWith(`/${DUPLICATE_BASENAME}`))
    ).toEqual([
      { index: 2, label: pathA },
      { index: 30, label: pathB }
    ])

    const beforeA = getWrapper(pathA)
    const beforeB = getWrapper(pathB)
    expect(beforeA).not.toBe(beforeB)

    // Row keys are full paths, so a shared basename is not a shared React key: an insert that
    // shifts both rows down one index leaves each holding its own node rather than swapping them.
    renderTree([conflictEntry(DUPLICATE_INSERTED_FILE_PATH), ...buildDuplicateBasenameEntries()])

    expect(getWrapper(pathA)).toBe(beforeA)
    expect(getWrapper(pathB)).toBe(beforeB)
    expect(beforeA.getAttribute('data-index')).toBe('3')
    expect(beforeB.getAttribute('data-index')).toBe('31')
  })

  it('collapses a directory inside the mounted window', () => {
    renderTree(buildEntries(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT))

    // `dir-04`'s header sits at index 205 (1 + 4 * 51) with its files at 206-255, so a window
    // started at index 200 holds the header and part of its subtree.
    scrollToIndex(200)
    expect(getMountedWindow()[0]?.index).toBe(190)
    expect(getMountedWindow().find((row) => row.label === 'dir-04')?.index).toBe(205)

    expect(getRow('dir-04').getAttribute('aria-expanded')).toBe('true')

    clickRow('dir-04')

    const header = getMountedRows().find((row) => getRowLabel(row) === 'dir-04')
    expect(header?.getAttribute('aria-expanded')).toBe('false')

    const collapsed = buildProjection(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT, new Set(['dir-04']))
    expect(collapsed.length).toBe(461)
    // Still far above the threshold, so the list cannot have fallen back to natural flow.
    expect(collapsed.length).toBeGreaterThanOrEqual(VIRTUALIZED_LIST_MIN_ROWS)
    expect(getVirtualListContainer().style.height).toBe(
      `${collapsed.length * CONFLICT_REVIEW_ROW_HEIGHT_PX}px`
    )
    expect(getMountedRows()).toHaveLength(expectedWindow(200, collapsed.length).count)
    expectWindowMatchesProjection(collapsed)
    expect(getScroller().querySelector(`[title="${filePath(4, 4)}"]`)).toBeNull()
  })

  it('keeps a collapse correct when the directory is above the mounted window', () => {
    renderTree(buildEntries(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT))
    const projection = buildProjection(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT)

    scrollToIndex(250)
    const labelAtIndex250 = getMountedWindow().find((row) => row.index === 250)?.label
    expect(labelAtIndex250).toBe(projection[250])

    // `dir-00`'s header is at index 1, so collapse it while it is mounted, then scroll past it.
    scrollToIndex(0)
    clickRow('dir-00')
    scrollToIndex(250)

    const collapsed = buildProjection(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT, new Set(['dir-00']))
    expect(collapsed.length).toBe(461)
    expect(getMountedRows()).toHaveLength(expectedWindow(250, collapsed.length).count)
    expectWindowMatchesProjection(collapsed)

    // Hiding `dir-00`'s 50 files moves every row below it up by 50 indices.
    scrollToIndex(200)
    expect(getMountedWindow().find((row) => row.index === 200)?.label).toBe(labelAtIndex250)
  })

  it('keeps a collapse correct when the directory is below the mounted window', () => {
    renderTree(buildEntries(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT))
    const projection = buildProjection(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT)

    scrollToIndex(0)
    const windowBefore = getMountedWindow()
    const heightBefore = getVirtualListContainer().style.height

    // `dir-09`'s header is the last one, at index 460; collapse it, then return to the top.
    scrollToIndex(460)
    expect(getMountedWindow().find((row) => row.label === 'dir-09')?.index).toBe(460)
    clickRow('dir-09')
    scrollToIndex(0)

    const collapsed = buildProjection(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT, new Set(['dir-09']))
    expect(collapsed.length).toBe(461)
    // The window is above the collapse, so it holds exactly the rows it held before.
    expect(getMountedWindow()).toEqual(windowBefore)
    expect(
      Number.parseInt(heightBefore, 10) - FILES_PER_DIRECTORY * CONFLICT_REVIEW_ROW_HEIGHT_PX
    ).toBe(Number.parseInt(getVirtualListContainer().style.height, 10))
    expect(projection.length - collapsed.length).toBe(FILES_PER_DIRECTORY)
  })

  it('highlights the selected row, opens a clicked file and indents by depth', () => {
    const openedEntries: GitStatusEntry[] = []
    const selectedPath = filePath(0, 10)
    renderTree(buildEntries(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT), {
      selectedPath,
      onOpenEntry: (entry) => openedEntries.push(entry)
    })

    const selected = getSelectedRows()
    expect(selected).toHaveLength(1)
    expect(selected[0]?.getAttribute('title')).toBe(selectedPath)

    const clickedPath = filePath(0, 20)
    expect(getRow(clickedPath).disabled).toBe(false)
    clickRow(clickedPath)
    expect(openedEntries).toHaveLength(1)
    expect(openedEntries[0]?.path).toBe(clickedPath)

    // `src` at depth 0, `dir-NN` at depth 1, files at depth 2 — unchanged under windowing.
    const rows = getMountedRows()
    expect(rows[0]?.style.paddingLeft).toBe(`${DIRECTORY_PADDING_PX}px`)
    expect(rows[1]?.style.paddingLeft).toBe(`${TREE_INDENT_PX + DIRECTORY_PADDING_PX}px`)
    expect(rows[2]?.style.paddingLeft).toBe(`${2 * TREE_INDENT_PX + FILE_PADDING_PX}px`)
  })

  it('selects and opens a row that first paint never mounted', () => {
    const openedEntries: GitStatusEntry[] = []
    const projection = buildProjection(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT)
    // Deep inside `dir-08`, hundreds of rows past the window the list opens with.
    const selectedPath = filePath(8, 8 + 25 * MERGE_DIRECTORY_COUNT)
    const selectedIndex = projection.indexOf(selectedPath)
    expect(selectedIndex).toBeGreaterThan(expectedWindow(0, projection.length).last)

    renderTree(buildEntries(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT), {
      selectedPath,
      onOpenEntry: (entry) => openedEntries.push(entry)
    })

    // Selection is model state, so an unmounted selected row highlights nothing at all.
    expect(getScroller().querySelector(`[title="${selectedPath}"]`)).toBeNull()
    expect(getSelectedRows()).toHaveLength(0)

    scrollToIndex(selectedIndex)

    expect(getMountedWindow().find((row) => row.index === selectedIndex)?.label).toBe(selectedPath)
    expect(getSelectedRows().map((row) => row.getAttribute('title'))).toEqual([selectedPath])

    clickRow(selectedPath)
    expect(openedEntries.map((entry) => entry.path)).toEqual([selectedPath])
  })

  it('carries two files sharing a basename their own DOM nodes below the virtualize threshold', () => {
    const [directoryA, directoryB] = DUPLICATE_DIRECTORIES
    const pathA = `src/${directoryA}/${DUPLICATE_BASENAME}`
    const pathB = `src/${directoryB}/${DUPLICATE_BASENAME}`
    const padA = `src/${directoryA}/pad-000.ts`
    const padB = `src/${directoryB}/pad-000.ts`
    const entries = buildDuplicateBasenameEntries(DUPLICATE_SUB_THRESHOLD_PADDING_PER_DIRECTORY)
    renderTree(entries)

    // Each duplicate is its own row, titled with its full path rather than the shared basename.
    const projection = ['src', directoryA, pathA, padA, directoryB, pathB, padB]
    expect(projection.length + 1).toBeLessThan(VIRTUALIZED_LIST_MIN_ROWS)
    expect(getMountedRows().map(getRowLabel)).toEqual(projection)
    // Natural flow has no keyed wrappers, so the row element's own key is all React reconciles by.
    expect(host.querySelector('[data-testid="virtualized-list"]')).toBeNull()
    expect(host.querySelectorAll('[data-index]')).toHaveLength(0)

    const beforeA = getRow(pathA)
    const beforeB = getRow(pathB)
    expect(beforeA).not.toBe(beforeB)

    renderTree([conflictEntry(DUPLICATE_INSERTED_FILE_PATH), ...entries])

    const withInserted = [
      'src',
      directoryA,
      DUPLICATE_INSERTED_FILE_PATH,
      pathA,
      padA,
      directoryB,
      pathB,
      padB
    ]
    expect(getMountedRows().map(getRowLabel)).toEqual(withInserted)
    // Row keys are full paths, so a shared basename is not a shared React key: both duplicates move
    // down a position holding their own nodes instead of inheriting whatever sat there before.
    expect(getMountedRows().indexOf(beforeA)).toBe(3)
    expect(getMountedRows().indexOf(beforeB)).toBe(6)
    expect(getRow(pathA)).toBe(beforeA)
    expect(getRow(pathB)).toBe(beforeB)
    expect(host.querySelectorAll('[data-index]')).toHaveLength(0)
  })

  it('re-projects a live status flip that leaves the file count unchanged', () => {
    const entries = buildEntries(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT)
    renderTree(entries)

    const flippedPath = filePath(0, 0)
    const before = getRow(flippedPath)
    expect(getRowBadgeText(before)).toBe('Unresolved')

    // The per-poll case: same paths and same count, one file resolved since the last status read.
    renderTree(
      entries.map((entry) =>
        entry.path === flippedPath ? conflictEntry(flippedPath, 'resolved_locally') : entry
      )
    )

    expect(getRow(flippedPath)).toBe(before)
    expect(getRowBadgeText(before)).toBe('Resolved')
  })

  it('badges each live status and refuses to open a file that left git status', () => {
    const openedEntries: GitStatusEntry[] = []
    const unresolvedPath = 'src/dir-00/unresolved.ts'
    const resolvedPath = 'src/dir-00/resolved.ts'
    const gonePath = 'src/dir-00/gone.ts'
    renderTree(
      [
        conflictEntry(unresolvedPath),
        conflictEntry(resolvedPath, 'resolved_locally'),
        conflictEntry(gonePath, 'gone')
      ],
      { onOpenEntry: (entry) => openedEntries.push(entry) }
    )

    // The badge is the element CONFLICT_REVIEW_ROW_HEIGHT_PX is derived from, in all three states.
    expect(getRowBadgeText(getRow(unresolvedPath))).toBe('Unresolved')
    expect(getRowBadgeText(getRow(resolvedPath))).toBe('Resolved')
    expect(getRowBadgeText(getRow(gonePath))).toBe('Gone')

    expect(getRow(gonePath).disabled).toBe(true)
    clickRow(gonePath)
    expect(openedEntries).toEqual([])

    clickRow(resolvedPath)
    expect(openedEntries.map((entry) => entry.path)).toEqual([resolvedPath])
  })

  it('keeps the empty state when the snapshot holds no conflicts', () => {
    renderTree([])

    // Zero rows fall below the threshold, where the list renders an empty fragment — so without the
    // guard above it the panel would be blank instead of explaining itself.
    expect(getScroller().textContent).toContain('No conflicts in this snapshot.')
    expect(getMountedRows()).toHaveLength(0)
    expect(host.querySelector('[data-testid="virtualized-list"]')).toBeNull()
  })
})

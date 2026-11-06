// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VIRTUALIZED_LIST_MIN_ROWS, VIRTUALIZED_LIST_OVERSCAN } from '@/components/virtualized-list'
import type {
  GitConflictKind,
  GitConflictResolutionStatus,
  GitStatusEntry
} from '../../../../shared/git/status/git-status-types'
import { ConflictReviewFileTree, CONFLICT_REVIEW_ROW_HEIGHT_PX } from './ConflictReviewFileTree'

const VIEWPORT_HEIGHT_PX = 600

const MERGE_FILE_COUNT = 500
const MERGE_DIRECTORY_COUNT = 10

// happy-dom has no layout: supply row/viewport heights and list offset geometry so margin measurement cannot accidentally pass at zero.
const ROWS_PER_VIEWPORT = Math.floor(VIEWPORT_HEIGHT_PX / CONFLICT_REVIEW_ROW_HEIGHT_PX)
// Match the scroller’s py-1 padding.
const MEASURED_SCROLL_MARGIN_PX = 4

type ConflictEntry = {
  path: string
  conflictKind: GitConflictKind
  liveEntry?: GitStatusEntry
}

// Pin no-op observation so mid-test resize delivery cannot change scroll margins.
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
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.classList.contains('overflow-auto')
      ? VIEWPORT_HEIGHT_PX
      : CONFLICT_REVIEW_ROW_HEIGHT_PX
  })
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

/** Offset the list by its margin minus current scrollTop so remeasurement restores the same content-relative margin. */
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

const DUPLICATE_BASENAME = 'index.ts'
const DUPLICATE_DIRECTORIES = ['dup-a', 'dup-b'] as const
// Choose padding to cover both sides of the virtualization threshold: 57 projected rows versus seven.
const DUPLICATE_PADDING_PER_DIRECTORY = 26
const DUPLICATE_SUB_THRESHOLD_PADDING_PER_DIRECTORY = 1
// Sorts ahead of `index.ts`, so inserting it shifts both duplicates down one index.
const DUPLICATE_INSERTED_FILE_PATH = `src/${DUPLICATE_DIRECTORIES[0]}/aaa-inserted.ts`

/** Repeat basenames across directories; globally indexed fixtures otherwise hide duplicate-key bugs. */
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

/** Snapshot entry with live conflict status, or gone when absent from Git status. */
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

function buildEntries(fileCount: number, directoryCount: number): ConflictEntry[] {
  return Array.from({ length: fileCount }, (_, index) =>
    conflictEntry(filePath(index % directoryCount, index))
  )
}

/** Project directory/file labels in tree order; compact no multi-child directories and omit collapsed descendants. */
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

function getMountedRows(): HTMLButtonElement[] {
  return Array.from(getScroller().querySelectorAll('button'))
}

function getRowLabel(row: HTMLButtonElement): string {
  return row.getAttribute('title') ?? row.querySelector('span')?.textContent ?? ''
}

function getMountedWindow(): { index: number; label: string }[] {
  return Array.from(getScroller().querySelectorAll('[data-index]')).map((wrapper) => {
    const row = wrapper.querySelector('button')
    if (!(row instanceof HTMLButtonElement)) {
      throw new Error('windowed wrapper has no row')
    }
    return { index: Number(wrapper.getAttribute('data-index')), label: getRowLabel(row) }
  })
}

/** Wrapper translation is list-relative, excluding the scroller margin. */
function getWrapperTransform(index: number): string {
  const wrapper = getScroller().querySelector(`[data-index="${index}"]`)
  if (!(wrapper instanceof HTMLElement)) {
    throw new Error(`wrapper for index ${index} is not mounted`)
  }
  return wrapper.style.transform
}

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

/** Match virtual-core’s partial-row inclusion plus bounded overscan; assumes row-aligned offsets and viewport height divisible by row height. */
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

/** Window wrapper identity tracks the keyed row across rerenders. */
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

    // Subtract the measured margin from scroller-wide item.start so row zero stays flush with the list.
    scrollToIndex(0)
    expect(getWrapperTransform(0)).toBe('translateY(0px)')
    expect(getWrapperTransform(20)).toBe(`translateY(${20 * CONFLICT_REVIEW_ROW_HEIGHT_PX}px)`)
  })

  it('keeps two files sharing a basename on separate rows with separate nodes', () => {
    const pathA = `src/${DUPLICATE_DIRECTORIES[0]}/${DUPLICATE_BASENAME}`
    const pathB = `src/${DUPLICATE_DIRECTORIES[1]}/${DUPLICATE_BASENAME}`
    renderTree(buildDuplicateBasenameEntries())

    expect(
      getMountedWindow().filter((row) => row.label.endsWith(`/${DUPLICATE_BASENAME}`))
    ).toEqual([
      { index: 2, label: pathA },
      { index: 30, label: pathB }
    ])

    const beforeA = getWrapper(pathA)
    const beforeB = getWrapper(pathB)
    expect(beforeA).not.toBe(beforeB)

    // Full-path keys must preserve both duplicate-basename nodes when insertion moves their indices.
    renderTree([conflictEntry(DUPLICATE_INSERTED_FILE_PATH), ...buildDuplicateBasenameEntries()])

    expect(getWrapper(pathA)).toBe(beforeA)
    expect(getWrapper(pathB)).toBe(beforeB)
    expect(beforeA.getAttribute('data-index')).toBe('3')
    expect(beforeB.getAttribute('data-index')).toBe('31')
  })

  it('keeps a collapse correct when the directory is above the mounted window', () => {
    renderTree(buildEntries(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT))
    const projection = buildProjection(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT)

    scrollToIndex(250)
    const labelAtIndex250 = getMountedWindow().find((row) => row.index === 250)?.label
    expect(labelAtIndex250).toBe(projection[250])

    scrollToIndex(0)
    clickRow('dir-00')
    scrollToIndex(250)

    const collapsed = buildProjection(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT, new Set(['dir-00']))
    expect(collapsed.length).toBe(461)
    expect(getMountedRows()).toHaveLength(expectedWindow(250, collapsed.length).count)
    expectWindowMatchesProjection(collapsed)

    // Collapsing 50 files shifts later projection indices by 50.
    scrollToIndex(200)
    expect(getMountedWindow().find((row) => row.index === 200)?.label).toBe(labelAtIndex250)
  })

  it('selects and opens a row that first paint never mounted', () => {
    const openedEntries: GitStatusEntry[] = []
    const projection = buildProjection(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT)
    const selectedPath = filePath(8, 8 + 25 * MERGE_DIRECTORY_COUNT)
    const selectedIndex = projection.indexOf(selectedPath)
    expect(selectedIndex).toBeGreaterThan(expectedWindow(0, projection.length).last)

    renderTree(buildEntries(MERGE_FILE_COUNT, MERGE_DIRECTORY_COUNT), {
      selectedPath,
      onOpenEntry: (entry) => openedEntries.push(entry)
    })

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

    const projection = ['src', directoryA, pathA, padA, directoryB, pathB, padB]
    expect(projection.length + 1).toBeLessThan(VIRTUALIZED_LIST_MIN_ROWS)
    expect(getMountedRows().map(getRowLabel)).toEqual(projection)
    // Natural flow has no wrapper keys; React identity belongs to each row element.
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
    // Duplicate basenames must retain their full-path keyed nodes after moving down an index.
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

    renderTree(
      entries.map((entry) =>
        entry.path === flippedPath ? conflictEntry(flippedPath, 'resolved_locally') : entry
      )
    )

    expect(getRow(flippedPath)).toBe(before)
    expect(getRowBadgeText(before)).toBe('Resolved')
  })
})

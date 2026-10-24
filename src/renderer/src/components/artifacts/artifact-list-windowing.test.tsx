// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VIRTUALIZED_LIST_OVERSCAN, VIRTUALIZED_LIST_MIN_ROWS } from '@/components/virtualized-list'
import type { ArtifactListItem } from '../../../../shared/artifacts'
import type * as ArtifactListRowModule from './ArtifactListRow'

const mountedRows = vi.hoisted(() => ({
  /** Rows mounted right now. */
  count: 0,
  /** Slug -> how many times a row for that slug has mounted, across the whole test. */
  mountsBySlug: new Map<string, number>()
}))

// Count real row mounts rather than restating virtualizer bookkeeping; match the shipped row’s lack of memoization.
vi.mock('./ArtifactListRow', async (importOriginal) => {
  const actual = await importOriginal<typeof ArtifactListRowModule>()
  const react = await import('react')
  const Row = actual.ArtifactListRow
  function CountingArtifactListRow(props: React.ComponentProps<typeof Row>): React.ReactNode {
    // Why: the slug this instance first rendered — a later slug on the same instance is reuse, not a mount.
    const mountSlug = react.useRef(props.item.artifact.slug)
    react.useEffect(() => {
      const slug = mountSlug.current
      mountedRows.count += 1
      mountedRows.mountsBySlug.set(slug, (mountedRows.mountsBySlug.get(slug) ?? 0) + 1)
      return () => {
        mountedRows.count -= 1
      }
    }, [])
    return react.createElement(Row, props)
  }
  return { ...actual, ArtifactListRow: CountingArtifactListRow }
})

const { ArtifactCollection } = await import('./ArtifactCollection')
const { TooltipProvider } = await import('@/components/ui/tooltip')
const { ARTIFACTS_TABLE_ROW_HEIGHT_PX } = await import('./artifacts-table-layout')

const VIEWPORT_HEIGHT_PX = 600
/** Pin this synthetic height to geometry derived from mounted row classes and to the virtualizer’s unmounted-row estimate. */
const SYNTHETIC_ROW_HEIGHT_PX = 53
// Exaggerate the sticky-header height so a wrong scroll margin selects a visibly different window.
const HEADER_HEIGHT_PX = 300
const VIRTUAL_SHELL_SELECTOR = '[data-testid="virtualized-list"]'
/** The row box itself: the grid that carries the padding, the divider and the selection wash. */
const ARTIFACT_ROW_SELECTOR = '[role="button"][tabindex="0"]'
/** Use literal classes to detect added width utilities such as w-fit, which shared constants would silently carry into expectations. */
const ARTIFACTS_GRID_CLASS =
  'grid grid-cols-[minmax(0,1.6fr)_minmax(4.5rem,6.5rem)_minmax(4rem,5.5rem)_minmax(6.5rem,9rem)_minmax(6.5rem,9rem)_2.5rem]'
const SCROLLER_CLASS =
  'scrollbar-sleek min-h-0 flex-1 overflow-auto rounded-md border border-border/50 bg-muted/20'
const TABLE_HEADER_CLASS = `${ARTIFACTS_GRID_CLASS} sticky top-0 z-30 h-8 items-center gap-3 border-b border-border/50 bg-[color-mix(in_srgb,var(--muted)_40%,var(--background))] px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground`
/** An unselected row that draws its divider — every windowed row but the list-final one. */
const ROW_CLASS = `${ARTIFACTS_GRID_CLASS} group/list-table-row w-full min-h-11 scroll-mt-8 cursor-pointer items-center gap-3 px-3 py-3 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 border-b border-border/50`
// Why `data-current` cannot stand in for the wash: it is set from a separate expression, so
// deleting the wash leaves the attribute while the user loses the only visible selection marker.
const SELECTED_ROW_CLASS = `${ROW_CLASS} bg-accent text-accent-foreground`
/** Takes the scroller's visible width, as the old `divide-y` band did; a static block box would even without `w-full`. */
const VIRTUAL_SHELL_CLASS = 'relative w-full'
/** Absolute row wrappers shrink to the grid’s 468px minimum without w-full and overhang narrower scrollers. */
const WINDOWED_ROW_WRAPPER_CLASS = 'absolute top-0 left-0 w-full'
/** The list-final row draws no divider, so this rule is its bottom edge. */
const LOAD_MORE_BLOCK_CLASS = 'border-t border-border/50 p-2'
const DAY_MS = 24 * 60 * 60 * 1000

type ResizeObserverBoxSize = { blockSize: number; inlineSize: number }

const activeResizeObservers = new Set<MockResizeObserver>()

class MockResizeObserver implements ResizeObserver {
  readonly elements = new Set<Element>()
  readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    activeResizeObservers.add(this)
  }

  observe(element: Element): void {
    this.elements.add(element)
  }

  unobserve(element: Element): void {
    this.elements.delete(element)
  }

  disconnect(): void {
    this.elements.clear()
    activeResizeObservers.delete(this)
  }
}

// Fire only observers watching the resized element, proving production observes the right target.
function fireResizeObservers(target?: Element): void {
  for (const observer of activeResizeObservers) {
    if (target && !observer.elements.has(target)) {
      continue
    }
    const targets = target ? [target] : Array.from(observer.elements)
    if (targets.length === 0) {
      continue
    }
    const entries = targets.map((element) => {
      const rect = element.getBoundingClientRect()
      const size: ResizeObserverBoxSize = { blockSize: rect.height, inlineSize: rect.width }
      return {
        target: element,
        contentRect: rect,
        borderBoxSize: [size],
        contentBoxSize: [size],
        devicePixelContentBoxSize: [size]
      } satisfies ResizeObserverEntry
    })
    observer.callback(entries, observer)
  }
}

function isObservedByAny(element: Element): boolean {
  return Array.from(activeResizeObservers).some((observer) => observer.elements.has(element))
}

let host: HTMLDivElement
let root: Root
/** Synthetic layout tops for getBoundingClientRect (happy-dom has no layout). */
let topsByElement: WeakMap<Element, number>
let scrollTopPatched: WeakSet<Element>
/** Current synthetic header height; tests grow it to move the list inside the scroller. */
let headerHeightPx: number

/** Tailwind's `text-sm` line box — what a row cell holding only text is tall. */
const TEXT_SM_LINE_BOX_PX = 20
/** What a row's `border-b` hairline adds to its border box. */
const ROW_DIVIDER_HEIGHT_PX = 1

// Splits `dark:hover:bg-accent/50` into its variants and the utility they gate. Tracks bracket
// depth because colons inside a variant (`[&_svg:not([class*='size-'])]:size-3`) are not separators.
function splitTailwindToken(token: string): { variants: string[]; utility: string } {
  const variants: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index]
    if (char === '[') {
      depth += 1
    } else if (char === ']') {
      depth -= 1
    } else if (char === ':' && depth === 0) {
      variants.push(token.slice(start, index))
      start = index + 1
    }
  }
  return { variants, utility: token.slice(start) }
}

/** `[&_svg…]`, `[&>span…]`: an arbitrary variant that reaches a descendant sizes that child, not this element. */
function isDescendantScopedVariant(variant: string): boolean {
  return /^\[&[_>+~]/.test(variant)
}

/** Resolve bare spacing tokens; throw on variants that make height conditional rather than silently choosing the shorter height. */
function spacingTokensPx(element: Element, prefix: string): number[] {
  const steps: number[] = []
  for (const token of element.classList) {
    const { variants, utility } = splitTailwindToken(token)
    if (!utility.startsWith(prefix)) {
      continue
    }
    if (variants.length > 0 && !variants.every(isDescendantScopedVariant)) {
      throw new Error(`variant-prefixed token "${token}" not supported on ${element.className}`)
    }
    if (variants.length > 0) {
      continue
    }
    const step = Number(utility.slice(prefix.length))
    if (!Number.isFinite(step)) {
      throw new Error(`non-numeric ${prefix} token "${token}" on ${element.className}`)
    }
    steps.push(step * 4)
  }
  return steps
}

/** px for the one Tailwind spacing token with this prefix, where exactly one is required. */
function spacingPx(element: Element, prefix: string): number {
  const values = spacingTokensPx(element, prefix)
  if (values.length !== 1) {
    throw new Error(`expected one ${prefix}N class, got ${values.length} on ${element.className}`)
  }
  return values[0] ?? 0
}

/** Prefixes that can set a box's height. `max-h-` only caps, so it cannot make a row taller. */
const HEIGHT_PREFIXES = ['size-', 'h-', 'min-h-'] as const

/** Tallest this element can be, from its own classes: its height tokens, or one text line. */
function elementBoxHeightPx(element: Element): number {
  const explicit = HEIGHT_PREFIXES.flatMap((prefix) => spacingTokensPx(element, prefix))
  return explicit.length > 0 ? Math.max(...explicit) : TEXT_SM_LINE_BOX_PX
}

/** Count exact border utilities only; border-border/50 is a color, and variant-gated widths make the measured height ambiguous. */
function rowDividerHeightPx(row: Element): number {
  let draws = false
  for (const token of row.classList) {
    const { variants, utility } = splitTailwindToken(token)
    if (utility !== 'border-b') {
      continue
    }
    if (variants.length > 0) {
      throw new Error(`variant-prefixed token "${token}" not supported on ${row.className}`)
    }
    draws = true
  }
  return draws ? ROW_DIVIDER_HEIGHT_PX : 0
}

/** Name | Type | Size | Updated | Expires | Actions — the six tracks of ARTIFACTS_TABLE_GRID_CLASS. */
const ARTIFACTS_ROW_CELL_COUNT = 6

/** Header label -> the value that column must hold, for the `artifact()` fixture at index 3. */
const LABELLED_ROW_COLUMNS = [
  ['Name', 'Artifact 3'],
  ['Type', 'HTML'],
  ['Size', '1.2 KB'],
  ['Updated', '3 days ago'],
  ['Expires', 'in 30 days']
] as const

/** Derive row height from its own padding, min-height, tallest descendant and divider. Unmounted estimates must match: an 8px error across 500 rows distorts scroll range by 4000px. */
function artifactRowHeightPx(row: Element): number {
  const boxes = Array.from(row.querySelectorAll('*'))
  // A mismatched cell count wraps the grid and doubles row height without enlarging any individual child.
  if (row.children.length !== ARTIFACTS_ROW_CELL_COUNT || boxes.length === 0) {
    throw new Error(
      `expected ${ARTIFACTS_ROW_CELL_COUNT} artifacts row cells, got ${row.children.length}`
    )
  }
  const tallestBox = Math.max(...boxes.map(elementBoxHeightPx))
  const padded = 2 * spacingPx(row, 'py-') + tallestBox
  return Math.max(padded, spacingPx(row, 'min-h-')) + rowDividerHeightPx(row)
}

function elementHeight(element: Element): number {
  if (element.classList.contains('overflow-auto')) {
    return VIEWPORT_HEIGHT_PX
  }
  if (element.classList.contains('sticky')) {
    return headerHeightPx
  }
  const row = element.matches(ARTIFACT_ROW_SELECTOR)
    ? element
    : element.querySelector(ARTIFACT_ROW_SELECTOR)
  // Other observed elements affect offsets on resize but have no height used by this synthetic layout.
  return row ? artifactRowHeightPx(row) : 0
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  mountedRows.count = 0
  mountedRows.mountsBySlug.clear()
  activeResizeObservers.clear()
  topsByElement = new WeakMap()
  scrollTopPatched = new WeakSet()
  headerHeightPx = HEADER_HEIGHT_PX
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)

  vi.stubGlobal('ResizeObserver', MockResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return elementHeight(this)
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const top = topsByElement.get(this) ?? 0
    const height = elementHeight(this)
    return {
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 640,
      width: 640,
      x: 0,
      y: top,
      toJSON: () => ({})
    }
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  activeResizeObservers.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// Use relative dates and separate Updated/Expires enough to keep their rendered strings distinct.
function artifact(slug: string, title: string): ArtifactListItem {
  const createdAt = new Date(Date.now() - 3 * DAY_MS).toISOString()
  return {
    artifact: {
      version: 1,
      slug,
      title,
      originalFileName: `${slug}.html`,
      sourceContentType: 'text/html',
      renderedContentType: 'text/html',
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
      byteSize: 1200,
      deletedAt: null
    },
    shareUrl: `https://share.onorca.dev/a/${slug}`
  }
}

function artifacts(count: number): ArtifactListItem[] {
  return Array.from({ length: count }, (_, index) => artifact(`a-${index}`, `Artifact ${index}`))
}

function scroller(): HTMLDivElement {
  const node = host.querySelector<HTMLDivElement>('.overflow-auto')
  if (!node) {
    throw new Error('artifacts scroller not rendered')
  }
  return node
}

/** The sticky table header — rendered unconditionally, as the scroller's first child. */
function tableHeader(): HTMLElement {
  const header = scroller().querySelector<HTMLElement>('.sticky')
  if (!header) {
    throw new Error('artifacts table header not rendered')
  }
  return header
}

function virtualShell(): HTMLElement | null {
  return host.querySelector<HTMLElement>(VIRTUAL_SHELL_SELECTOR)
}

function requireVirtualShell(): HTMLElement {
  const shell = virtualShell()
  if (!shell) {
    throw new Error('virtual shell not rendered')
  }
  return shell
}

/** Derive layout tops from preceding in-flow siblings so scroll-margin assertions cannot restate an assigned offset. */
function inFlowTopWithinScroller(element: Element): number {
  const scrollerNode = scroller()
  let top = 0
  let node: Element | null = element
  while (node && node !== scrollerNode) {
    for (let prev = node.previousElementSibling; prev; prev = prev.previousElementSibling) {
      top += elementHeight(prev)
    }
    node = node.parentElement
  }
  return top
}

function applyShellLayout(): void {
  const shell = virtualShell()
  if (shell) {
    topsByElement.set(shell, inFlowTopWithinScroller(shell) - scroller().scrollTop)
  }
}

/** Real layout the browser would supply: scroller at 0, list below the sticky header. */
function syncLayout(): void {
  const node = scroller()
  if (!scrollTopPatched.has(node)) {
    scrollTopPatched.add(node)
    Object.defineProperty(node, 'scrollTop', { configurable: true, writable: true, value: 0 })
  }
  topsByElement.set(node, 0)
  applyShellLayout()
  act(() => {
    fireResizeObservers()
  })
}

function scrollTo(offset: number): void {
  const node = scroller()
  node.scrollTop = offset
  applyShellLayout()
  act(() => {
    node.dispatchEvent(new Event('scroll'))
  })
}

/** Grows the sticky header — the one thing inside the scroller that moves the list's offset. */
function setHeaderHeight(height: number): void {
  headerHeightPx = height
  applyShellLayout()
  act(() => {
    // Only the scroller child that actually changed height reports a resize.
    fireResizeObservers(tableHeader())
  })
}

// The sticky header alone precedes the shell; a wrong derived margin shifts the expected first mounted row.
function expectedFirstWindowedIndex(scrollOffsetPx: number): number {
  const firstVisible = Math.floor((scrollOffsetPx - headerHeightPx) / SYNTHETIC_ROW_HEIGHT_PX)
  return Math.max(0, firstVisible - VIRTUALIZED_LIST_OVERSCAN)
}

function renderCollection({
  items,
  selectedSlug = null,
  deletingId = null,
  hasMore = false,
  selectArtifact = vi.fn(),
  loadMore = vi.fn()
}: {
  items: readonly ArtifactListItem[]
  selectedSlug?: string | null
  deletingId?: string | null
  hasMore?: boolean
  selectArtifact?: (slug: string) => void
  loadMore?: () => void
}): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <ArtifactCollection
          artifacts={items}
          deletingId={deletingId}
          selectedSlug={selectedSlug}
          selectArtifact={selectArtifact}
          deleteArtifact={vi.fn()}
          hasMore={hasMore}
          loadingMore={false}
          loadMore={loadMore}
          onRefresh={vi.fn()}
          isRefreshing={false}
        />
      </TooltipProvider>
    )
  })
  syncLayout()
}

// Use the delegated native setter; direct assignment also updates React’s value tracker and swallows the change.
function typeSearchQuery(text: string): void {
  const input = host.querySelector('input')
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!input || !setValue) {
    throw new Error('artifacts search field not rendered')
  }
  act(() => {
    setValue.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  syncLayout()
}

function windowedIndexes(): number[] {
  return Array.from(host.querySelectorAll<HTMLElement>('[data-index]'), (element) =>
    Number(element.dataset.index)
  )
}

function rowAtIndex(index: number): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[data-index="${index}"]`)
}

/** Clicks Load more and returns it, so a caller can assert it was actually reachable. */
function clickLoadMore(): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes('Load more')
  )
  if (!button) {
    throw new Error('Load more button not rendered')
  }
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  return button
}

/** Read deleting from the row’s portaled menu, then close it so the next lookup cannot match this row’s action. */
function deleteActionDisabled(index: number): boolean {
  const trigger = rowAtIndex(index)?.querySelector<HTMLElement>('button[aria-label]')
  if (!trigger) {
    throw new Error(`row ${index} has no actions trigger`)
  }
  const toggleMenu = (): void => {
    act(() => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    })
  }
  toggleMenu()
  // Radix portals menus to `document.body`, so a leaked open one would leave the lookup below
  // free to match the previous row's item.
  expect(document.querySelectorAll('[role="menu"]').length).toBe(1)
  const items = Array.from(document.querySelectorAll('[role="menuitem"]'))
  const remove = items.find((item) => item.textContent?.includes('Delete artifact'))
  if (!remove) {
    throw new Error(`actions menu for row ${index} has no delete item`)
  }
  const disabled = remove.getAttribute('aria-disabled') === 'true'
  toggleMenu()
  return disabled
}

/** Scroll offset that puts the last of `rowCount` rows at the bottom of the viewport. */
function bottomScrollOffset(rowCount: number): number {
  return HEADER_HEIGHT_PX + rowCount * SYNTHETIC_ROW_HEIGHT_PX - VIEWPORT_HEIGHT_PX
}

/** Require one divider with the exact color: added top borders double hairlines, while a missing color falls back to currentColor. */
function expectRowDivider(row: Element | null | undefined): void {
  expect(row).toBeTruthy()
  expect(row?.classList.contains('border-b')).toBe(true)
  expect(row?.classList.contains('border-border/50')).toBe(true)
  expect(row?.classList.contains('border-t')).toBe(false)
}

/** The list-final row: no rule on either edge, so nothing doubles the block that follows it. */
function expectNoRowDivider(row: Element | null | undefined): void {
  expect(row).toBeTruthy()
  expect(row?.classList.contains('border-b')).toBe(false)
  expect(row?.classList.contains('border-t')).toBe(false)
}

/** Empty text must center in viewport width; reject width/min-width/max-width utilities or a w-fit band that would center it offscreen. */
function expectCenteredEmptyState(): void {
  const empty = host.querySelector('p')
  expect(empty?.textContent).toContain('No matches')
  expect(empty?.parentElement).toBe(scroller())
  expect(empty?.classList.contains('text-center')).toBe(true)
  const widthTokens = Array.from(empty?.classList ?? []).filter((token) =>
    /^(?:min-|max-)?w-/.test(token)
  )
  expect(widthTokens).toEqual([])
}

function mountCountsSnapshot(): Map<string, number> {
  return new Map(mountedRows.mountsBySlug)
}

/** Slugs whose row mounted again after `before` — i.e. lost their identity across the update. */
function slugsRemountedSince(before: ReadonlyMap<string, number>): string[] {
  return Array.from(before)
    .filter(([slug, count]) => (mountedRows.mountsBySlug.get(slug) ?? 0) > count)
    .map(([slug]) => slug)
}

describe('artifacts list windowing — below the threshold', () => {
  it('renders every row in natural flow with no virtual shell', () => {
    const count = VIRTUALIZED_LIST_MIN_ROWS - 10
    renderCollection({ items: artifacts(count) })

    expect(count).toBe(40)
    expect(mountedRows.count).toBe(count)
    expect(virtualShell()).toBeNull()
    expect(host.querySelectorAll('[data-index]').length).toBe(0)
    // Below threshold, inspect direct children to catch a wrapper band that widens washes or adds duplicate rules.
    const children = Array.from(scroller().children)
    expect(children.length).toBe(count + 1)
    expect(children[0]).toBe(tableHeader())
    for (const child of children.slice(1)) {
      expect(child.matches(ARTIFACT_ROW_SELECTOR)).toBe(true)
    }
  })

  it('draws a separator on every row but the last, matching the removed divide-y', () => {
    renderCollection({ items: artifacts(VIRTUALIZED_LIST_MIN_ROWS - 10) })

    const rows = Array.from(host.querySelectorAll<HTMLElement>('[role="button"][tabindex="0"]'))
    expect(rows.length).toBe(40)
    for (const row of rows.slice(0, -1)) {
      expectRowDivider(row)
    }
    expectNoRowDivider(rows.at(-1))
  })

  it('keeps a prepended artifact from remounting the rows already on screen', () => {
    const base = artifacts(VIRTUALIZED_LIST_MIN_ROWS - 10)
    renderCollection({ items: base })
    const before = mountCountsSnapshot()
    expect(before.size).toBe(base.length)

    renderCollection({ items: [artifact('a-new', 'Artifact new'), ...base] })

    expect(slugsRemountedSince(before)).toEqual([])
    expect(mountedRows.mountsBySlug.get('a-new')).toBe(1)
    expect(mountedRows.count).toBe(base.length + 1)
  })
})

describe('artifacts list windowing — above the threshold', () => {
  // Read actual row classes so button size, shared padding and divider changes cannot silently invalidate unmounted estimates.
  it('pins the production row-height estimate to the geometry the row classes actually describe', () => {
    renderCollection({ items: artifacts(500) })

    const row = host.querySelector(ARTIFACT_ROW_SELECTOR)
    expect(row).not.toBeNull()
    expect(row && artifactRowHeightPx(row)).toBe(ARTIFACTS_TABLE_ROW_HEIGHT_PX)
    expect(ARTIFACTS_TABLE_ROW_HEIGHT_PX).toBe(SYNTHETIC_ROW_HEIGHT_PX)
  })

  // The divider-free final row is a pixel shorter; measurement must replace its uniform estimate once visible.
  it('hands each windowed row to the virtualizer to measure, and corrects the estimate', () => {
    renderCollection({ items: artifacts(500) })
    const shell = requireVirtualShell()

    for (const wrapper of host.querySelectorAll('[data-index]')) {
      expect(isObservedByAny(wrapper)).toBe(true)
    }
    expect(Number.parseInt(shell.style.height, 10)).toBe(500 * SYNTHETIC_ROW_HEIGHT_PX)

    scrollTo(HEADER_HEIGHT_PX + 499 * SYNTHETIC_ROW_HEIGHT_PX)
    const lastRow = rowAtIndex(499)
    if (!lastRow) {
      throw new Error('list-final row not windowed')
    }
    // Otherwise the correction below would be vacuous: nothing to correct.
    expect(elementHeight(lastRow)).toBeLessThan(SYNTHETIC_ROW_HEIGHT_PX)
    expect(Number.parseInt(shell.style.height, 10)).toBe(500 * SYNTHETIC_ROW_HEIGHT_PX)

    // Resize only the measured row; the shared virtualizer’s measurement ref must supply the correction.
    act(() => {
      fireResizeObservers(lastRow)
    })
    expect(Number.parseInt(shell.style.height, 10)).toBe(
      499 * SYNTHETIC_ROW_HEIGHT_PX + elementHeight(lastRow)
    )
  })

  it('mounts only a bounded window for a 500-artifact list', () => {
    renderCollection({ items: artifacts(500) })

    const shell = requireVirtualShell()
    // 6 visible (600px viewport less the 300px header, over 53px rows) plus 10 overscan.
    expect(mountedRows.count).toBe(16)
    expect(mountedRows.count).toBeLessThan(VIRTUALIZED_LIST_MIN_ROWS)
    expect(host.querySelectorAll('[data-index]').length).toBe(mountedRows.count)
    // The scrollbar still represents all 500 rows: mounted rows measure at the height the
    // virtualizer estimates unmounted ones at, so the total is exact.
    expect(Number.parseInt(shell.style.height, 10)).toBe(500 * SYNTHETIC_ROW_HEIGHT_PX)

    // A screen reader hears all 500 at their true places, not the 16 the window happens to hold.
    expect(shell.getAttribute('role')).toBe('list')
    scrollTo(HEADER_HEIGHT_PX + 100 * SYNTHETIC_ROW_HEIGHT_PX)
    // Deep into the list, so window-relative numbering could not pass as the absolute index.
    expect(Math.min(...windowedIndexes())).toBeGreaterThan(mountedRows.count)
    expect(
      Array.from(host.querySelectorAll<HTMLElement>('[data-index]'), (wrapper) => [
        wrapper.getAttribute('role'),
        wrapper.getAttribute('aria-setsize'),
        wrapper.getAttribute('aria-posinset')
      ])
    ).toEqual(windowedIndexes().map((index) => ['listitem', '500', String(index + 1)]))
  })

  // Literal class equality catches added min-w-max, which would extend header tint and row washes to scroll width.
  it('keeps the header and the windowed rows on the one shared column template', () => {
    renderCollection({ items: artifacts(500) })

    expect(tableHeader().className).toBe(TABLE_HEADER_CLASS)
    const rows = Array.from(host.querySelectorAll(`[data-index] ${ARTIFACT_ROW_SELECTOR}`))
    expect(rows.length).toBe(16)
    for (const row of rows) {
      expect(row.className).toBe(ROW_CLASS)
    }
  })

  // Correct tracks alone cannot catch swapped values under the wrong date headers.
  it('puts each row value under the header that names it', () => {
    renderCollection({ items: artifacts(500) })

    const headers = Array.from(tableHeader().children, (cell) => cell.textContent)
    const row = rowAtIndex(3)?.querySelector(ARTIFACT_ROW_SELECTOR)
    const values = Array.from(row?.children ?? [], (cell) => cell.textContent).slice(0, -1)

    expect(headers).toEqual([...LABELLED_ROW_COLUMNS.map(([header]) => header), 'Actions'])
    expect(values).toEqual(LABELLED_ROW_COLUMNS.map(([, value]) => value))
    // Without distinct values a swapped pair would still satisfy the line above.
    expect(new Set(values).size).toBe(LABELLED_ROW_COLUMNS.length)
  })

  it('keeps the header and the virtual shell as the scrollers own children, at the visible width', () => {
    renderCollection({ items: artifacts(500) })

    // Preserve the pre-windowing direct-child structure; content-width bands would extend washes and scroll range.
    const children = Array.from(scroller().children)
    expect(children.length).toBe(2)
    expect(children[0]).toBe(tableHeader())
    expect(children[1]).toBe(requireVirtualShell())
    // Pinned, not `toContain`: a presence check cannot see an added width or overflow utility.
    expect(scroller().className).toBe(SCROLLER_CLASS)
    expect(tableHeader().className).toBe(TABLE_HEADER_CLASS)
    expect(requireVirtualShell().className).toBe(VIRTUAL_SHELL_CLASS)
    const wrappers = Array.from(host.querySelectorAll('[data-index]'))
    expect(wrappers.length).toBe(16)
    for (const wrapper of wrappers) {
      expect(wrapper.className).toBe(WINDOWED_ROW_WRAPPER_CLASS)
    }
  })

  it('separates every windowed row and stops at the list-final row, not the window-final one', () => {
    renderCollection({ items: artifacts(500) })

    const windowedRows = Array.from(
      host.querySelectorAll<HTMLElement>('[data-index] [role="button"]')
    )
    expect(windowedRows.length).toBe(16)
    for (const row of windowedRows) {
      expectRowDivider(row)
    }

    // Only full-list slug identity can find row 499; window-relative checks cannot identify the final row.
    scrollTo(HEADER_HEIGHT_PX + 499 * SYNTHETIC_ROW_HEIGHT_PX)
    expectNoRowDivider(rowAtIndex(499)?.querySelector('[role="button"]'))
    for (const index of [497, 498]) {
      expectRowDivider(rowAtIndex(index)?.querySelector('[role="button"]'))
    }
  })
})

describe('artifacts list windowing — scroll margin', () => {
  it('windows from the list offset inside the scroller, not from the scroller top', () => {
    renderCollection({ items: artifacts(500) })

    const offset = HEADER_HEIGHT_PX + 200 * SYNTHETIC_ROW_HEIGHT_PX
    scrollTo(offset)

    const firstIndex = Math.min(...windowedIndexes())
    expect(firstIndex).toBe(expectedFirstWindowedIndex(offset))
    // Rows position inside the shell, so a windowed row sits at index × row height regardless of offset.
    const probe = firstIndex + 3
    expect(rowAtIndex(probe)?.style.transform).toBe(
      `translateY(${probe * SYNTHETIC_ROW_HEIGHT_PX}px)`
    )
  })

  it('re-measures and re-windows when the header above the list grows', () => {
    renderCollection({ items: artifacts(500) })
    const offset = HEADER_HEIGHT_PX + 200 * SYNTHETIC_ROW_HEIGHT_PX
    scrollTo(offset)
    expect(Math.min(...windowedIndexes())).toBe(expectedFirstWindowedIndex(offset))

    const grownHeader = HEADER_HEIGHT_PX + 10 * SYNTHETIC_ROW_HEIGHT_PX
    setHeaderHeight(grownHeader)

    // The same scroll offset now lands 10 rows earlier in the list.
    expect(Math.min(...windowedIndexes())).toBe(expectedFirstWindowedIndex(offset))
  })
})

describe('artifacts list windowing — row identity', () => {
  it('reuses the same virtual shell across insert, remove, and reorder', () => {
    const base = artifacts(500)
    renderCollection({ items: base })
    const shell = requireVirtualShell()

    renderCollection({ items: [artifact('a-new', 'Artifact new'), ...base] })
    expect(virtualShell()).toBe(shell)
    expect(rowAtIndex(0)?.textContent).toContain('Artifact new')

    renderCollection({ items: base.slice(1) })
    expect(virtualShell()).toBe(shell)
    expect(rowAtIndex(0)?.textContent).toContain('Artifact 1')
    // Still the one window — 6 visible plus 10 overscan — after insert and remove.
    expect(mountedRows.count).toBe(16)

    const reordered = [...base.slice(0, 30).toReversed(), ...base.slice(30)]
    renderCollection({ items: reordered, selectedSlug: 'a-29' })
    expect(virtualShell()).toBe(shell)
    expect(rowAtIndex(0)?.textContent).toContain('Artifact 29')
    const current = host.querySelectorAll('[data-current="true"]')
    expect(current.length).toBe(1)
    expect(rowAtIndex(0)?.contains(current[0] ?? null)).toBe(true)
    // Selection must retain the divider; this selected render exposes an incorrect !isSelected gate.
    expectRowDivider(current[0])
  })

  it('keeps every windowed row on its own slug when an artifact is prepended', () => {
    // Duplicate titles with distinct slugs expose title-key collisions that could reuse the wrong artifact row.
    const base = Array.from({ length: 500 }, (_, index) =>
      artifact(`a-${index}`, `Artifact ${Math.floor(index / 2)}`)
    )
    renderCollection({ items: base })
    const before = mountCountsSnapshot()
    // Before measuring scroll margin, the first window may briefly fill the viewport; bound total mounts below the full-list threshold.
    expect(before.size).toBeLessThan(VIRTUALIZED_LIST_MIN_ROWS)
    expect(before.size).toBeGreaterThanOrEqual(mountedRows.count)

    renderCollection({ items: [artifact('a-new', 'Artifact new'), ...base] })

    // Slug keys move a row to its new index; index keys would hand its slot to the next artifact.
    expect(slugsRemountedSince(before)).toEqual([])
    expect(mountedRows.mountsBySlug.get('a-new')).toBe(1)
    expect(rowAtIndex(0)?.textContent).toContain('Artifact new')
  })

  it('gives every windowed row a distinct index', () => {
    renderCollection({ items: artifacts(500) })

    const indexes = windowedIndexes()
    // 6 visible plus 10 overscan.
    expect(indexes.length).toBe(16)
    expect(new Set(indexes).size).toBe(indexes.length)
  })
})

describe('artifacts list windowing — surface behaviors', () => {
  it('selects from a windowed row', () => {
    const selectArtifact = vi.fn()
    renderCollection({ items: artifacts(500), selectArtifact })

    const row = rowAtIndex(3)?.querySelector<HTMLElement>('[role="button"]')
    expect(row).not.toBeNull()
    act(() => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(selectArtifact).toHaveBeenCalledTimes(1)
    expect(selectArtifact).toHaveBeenCalledWith('a-3')
  })

  it('disables delete only on the row that is being deleted', () => {
    renderCollection({ items: artifacts(500), deletingId: 'a-3' })

    expect(deleteActionDisabled(3)).toBe(true)
    // Conditional, not unconditional: its neighbour in the same window is still deletable.
    expect(deleteActionDisabled(4)).toBe(false)
  })

  // The context menu maps actions separately; verify parity with the dropdown.
  it('right-clicking a windowed row offers the same actions as its dropdown', () => {
    renderCollection({ items: artifacts(500) })
    scrollTo(HEADER_HEIGHT_PX + 400 * SYNTHETIC_ROW_HEIGHT_PX)
    const row = rowAtIndex(400)?.querySelector<HTMLElement>(ARTIFACT_ROW_SELECTOR)
    expect(row).not.toBeNull()

    act(() => {
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })

    // Radix mounts menu content only while the menu is open, so a match here is the menu opening.
    const labels = Array.from(document.querySelectorAll('[role="menuitem"]'), (i) => i.textContent)
    expect(labels).toEqual(['Copy link', 'Open in browser', 'Delete artifact'])
  })

  it('keeps selection while the selected row is outside the window', () => {
    renderCollection({ items: artifacts(500), selectedSlug: 'a-400' })

    expect(host.querySelector('[data-current="true"]')).toBeNull()
    expect(rowAtIndex(400)).toBeNull()

    scrollTo(HEADER_HEIGHT_PX + 400 * SYNTHETIC_ROW_HEIGHT_PX)

    const selected = rowAtIndex(400)?.querySelector('[data-current="true"]')
    expect(selected).not.toBeNull()
    expect(host.querySelectorAll('[data-current="true"]').length).toBe(1)
    expect(selected?.className).toBe(SELECTED_ROW_CLASS)
    // Conditional, not unconditional: its neighbour in the same window carries no wash.
    expect(rowAtIndex(399)?.querySelector(ARTIFACT_ROW_SELECTOR)?.className).toBe(ROW_CLASS)
  })

  it('appends a page without a scroll jump or a shell remount', () => {
    const loadMore = vi.fn()
    const base = artifacts(500)
    renderCollection({ items: base, hasMore: true, loadMore })
    const shell = requireVirtualShell()

    scrollTo(5000)
    const indexesBeforeAppend = windowedIndexes()
    const topIndex = Math.min(...indexesBeforeAppend)
    const topSlugText = rowAtIndex(topIndex)?.textContent
    const topTransformBeforeAppend = rowAtIndex(topIndex)?.style.transform
    expect(topTransformBeforeAppend).toBeTruthy()
    const heightBeforeAppend = Number.parseInt(shell.style.height, 10)

    clickLoadMore()
    expect(loadMore).toHaveBeenCalledTimes(1)

    renderCollection({ items: [...base, ...artifacts(600).slice(500)], hasMore: false, loadMore })

    expect(scroller().scrollTop).toBe(5000)
    expect(virtualShell()).toBe(shell)
    expect(Number.parseInt(shell.style.height, 10)).toBeGreaterThan(heightBeforeAppend)
    expect(rowAtIndex(topIndex)?.textContent).toBe(topSlugText)
    // The anti-jump property directly: the same index still sits at the same pixel offset.
    expect(rowAtIndex(topIndex)?.style.transform).toBe(topTransformBeforeAppend)
  })

  it('keeps the scroll margin when the Load more block leaves the scroller', () => {
    const base = artifacts(500)
    renderCollection({ items: base, hasMore: true })

    // Every scroller child is watched, so any of them resizing re-measures the list's offset.
    expect(scroller().children.length).toBe(3)
    const loadMoreBlock = scroller().lastElementChild
    expect(loadMoreBlock?.textContent).toContain('Load more')
    // Exact equality catches a missing top rule; the final row has no divider of its own.
    expect(loadMoreBlock?.className).toBe(LOAD_MORE_BLOCK_CLASS)
    expect(isObservedByAny(tableHeader())).toBe(true)
    expect(isObservedByAny(requireVirtualShell())).toBe(true)
    expect(loadMoreBlock ? isObservedByAny(loadMoreBlock) : false).toBe(true)

    const offset = HEADER_HEIGHT_PX + 200 * SYNTHETIC_ROW_HEIGHT_PX
    scrollTo(offset)
    expect(Math.min(...windowedIndexes())).toBe(expectedFirstWindowedIndex(offset))

    renderCollection({ items: base, hasMore: false })

    expect(scroller().children.length).toBe(2)
    expect(scroller().textContent).not.toContain('Load more')
    expect(Math.min(...windowedIndexes())).toBe(expectedFirstWindowedIndex(offset))
    expect(mountedRows.count).toBe(windowedIndexes().length)
    expect(mountedRows.count).toBeLessThan(VIRTUALIZED_LIST_MIN_ROWS)
  })

  it('shows the empty state with no window and no mounted rows', () => {
    renderCollection({ items: [] })

    expect(host.textContent).toContain('No matches')
    // The header renders either way, so the empty state reads as an empty table, not a blank panel.
    expect(scroller().children.length).toBe(2)
    expect(scroller().firstElementChild).toBe(tableHeader())
    expectCenteredEmptyState()
    expect(virtualShell()).toBeNull()
    expect(mountedRows.count).toBe(0)
  })

  // A query may hide every loaded row while the server still has a cursor; keep both empty text and Load more reachable.
  it('shows the empty state alongside Load more when a search filters every row away', () => {
    renderCollection({ items: [], hasMore: true })

    const children = Array.from(scroller().children)
    expect(children.length).toBe(3)
    expect(children[0]).toBe(tableHeader())
    expectCenteredEmptyState()
    const loadMoreBlock = children[2]
    expect(loadMoreBlock?.textContent).toContain('Load more')
    expect(loadMoreBlock?.className).toBe(LOAD_MORE_BLOCK_CLASS)
    expect(virtualShell()).toBeNull()
    expect(mountedRows.count).toBe(0)
  })
})

/** Crossing the windowing threshold attaches the shared scroller; preserve the current offset instead of accepting the virtualizer’s default top. Appends already above threshold cannot test this. */
describe('artifacts list windowing — crossing the virtualize threshold', () => {
  it('keeps the scroll position when Load more pushes the list over the threshold', () => {
    const loadMore = vi.fn()
    const base = artifacts(VIRTUALIZED_LIST_MIN_ROWS - 10)
    renderCollection({ items: base, hasMore: true, loadMore })
    expect(virtualShell()).toBeNull()

    // Load more is reachable only at the bottom of these 40 rows below the 300px header.
    const offset = bottomScrollOffset(base.length)
    scrollTo(offset)
    clickLoadMore()
    expect(loadMore).toHaveBeenCalledTimes(1)

    renderCollection({ items: artifacts(80), hasMore: false, loadMore })

    expect(virtualShell()).not.toBeNull()
    expect(scroller().scrollTop).toBe(offset)
    // And the user is still looking at the rows they were: the window, not just the raw offset.
    expect(Math.min(...windowedIndexes())).toBe(expectedFirstWindowedIndex(offset))
  })

  it('keeps the scroll position across the exact row count that gates virtualization', () => {
    const base = artifacts(VIRTUALIZED_LIST_MIN_ROWS - 1)
    renderCollection({ items: base, hasMore: true })
    expect(virtualShell()).toBeNull()

    const offset = bottomScrollOffset(base.length)
    scrollTo(offset)
    clickLoadMore()

    // One more row is the whole difference: 49 renders plainly, 50 windows.
    renderCollection({ items: artifacts(VIRTUALIZED_LIST_MIN_ROWS), hasMore: false })

    expect(virtualShell()).not.toBeNull()
    expect(scroller().scrollTop).toBe(offset)
    expect(Math.min(...windowedIndexes())).toBe(expectedFirstWindowedIndex(offset))
  })

  it('keeps the scroll position when clearing a search restores the list over the threshold', () => {
    // Search reduces 60 rows to 45, then clearing it reattaches windowing without another page load.
    const items = Array.from({ length: 60 }, (_, index) =>
      artifact(`a-${index}`, index < 45 ? `Keep ${index}` : `Drop ${index}`)
    )
    renderCollection({ items })
    requireVirtualShell()

    // Inside the filtered list's scroll range too, so the browser would not have clamped it.
    const offset = HEADER_HEIGHT_PX + 20 * SYNTHETIC_ROW_HEIGHT_PX
    scrollTo(offset)

    typeSearchQuery('keep')
    expect(virtualShell()).toBeNull()
    expect(mountedRows.count).toBe(45)

    typeSearchQuery('')

    expect(virtualShell()).not.toBeNull()
    expect(scroller().scrollTop).toBe(offset)
    expect(Math.min(...windowedIndexes())).toBe(expectedFirstWindowedIndex(offset))
  })
})

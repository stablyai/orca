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

// Why the real row and not a spy on the virtualizer: a spy would only restate its own
// bookkeeping. Not memoized, because the shipped row is not either.
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

const VIEWPORT_HEIGHT_PX = 600
const SYNTHETIC_ROW_HEIGHT_PX = 53
const HEADER_HEIGHT_PX = 300
const VIRTUAL_SHELL_SELECTOR = '[data-testid="virtualized-list"]'
const ARTIFACT_ROW_SELECTOR = '[role="button"][tabindex="0"]'
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

// With a `target`, only observers actually watching that element fire, and only for it — so
// resizing one element proves production observes *that* element, not merely something.
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

const LABELLED_ROW_COLUMNS = [
  ['Name', 'Artifact 3'],
  ['Type', 'HTML'],
  ['Size', '1.2 KB'],
  ['Updated', '3 days ago'],
  ['Expires', 'in 30 days']
] as const

let measuredHeights: WeakMap<Element, number>

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
  // Why 0 otherwise: nothing else here has a load-bearing height — the Load more block and the
  // empty-state paragraph are observed for resizes, never summed into an offset or windowed against.
  return row ? (measuredHeights.get(element) ?? SYNTHETIC_ROW_HEIGHT_PX) : 0
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  mountedRows.count = 0
  mountedRows.mountsBySlug.clear()
  activeResizeObservers.clear()
  measuredHeights = new WeakMap()
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

// Why: relative to now — the row labels are relative times, so fixed dates would rot. The two
// timestamps are far apart so Updated and Expires never render the same string.
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

/**
 * Where the browser would put `element` in the scroller's content: the summed heights of the
 * in-flow siblings before it. Derived, not assigned — a hardcoded shell top would make every
 * scroll-margin assertion restate the number the test chose.
 */
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

// First index the virtualizer must mount at this offset. The sticky header is the shell's only
// in-flow predecessor, so the margin production derives from the DOM comes to `headerHeightPx`;
// dropping or mis-deriving it resolves a window several rows down the list.
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

// React tracks the input's own value, so assigning `input.value` updates that tracker too and the
// change is swallowed as a no-op — the write must go through the setter the tracker delegates to.
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

/**
 * Whether a windowed row's Delete action is disabled — the row's only rendering of `deleting`.
 * Radix mounts the menu only while it is open and portals it out of `host`, so the state cannot be
 * read off the row; the menu is toggled back shut so the next row reads its own.
 */
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

/**
 * A row carrying the separator. Both edges: a constant that gained `border-t` would paint two
 * hairlines between every pair of rows while every `toBe(true)` here still passed. Colour spelled
 * out because Tailwind's default is `currentColor` — a dropped token tints every hairline.
 */
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

/**
 * `text-center` on a direct scroller child centers in the visible width; inside a `w-fit` band or
 * with a width utility of its own it would center over the scroll width — partly off screen.
 * `min-w-`/`max-w-` floor or cap that box just as `w-` sets it, so all three prefixes are refused.
 */
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
    // Why the structure and not just the count: any band reintroduced around the rows — sized to
    // its content, or carrying a rule of its own — would widen the wash or double every hairline,
    // and below the threshold nothing else in this file would see it.
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
  // A targeted resize must correct the estimate through the real measurement ref.
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
    measuredHeights.set(lastRow, SYNTHETIC_ROW_HEIGHT_PX - 1)
    expect(elementHeight(lastRow)).toBeLessThan(SYNTHETIC_ROW_HEIGHT_PX)
    expect(Number.parseInt(shell.style.height, 10)).toBe(500 * SYNTHETIC_ROW_HEIGHT_PX)

    // Targeted, so only an observer already watching this wrapper can fire: the correction can
    // come from nothing but the measurement ref the shared virtual list puts on the wrapper.
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

  // Why the values and not just the tracks: the grid keeps six columns aligned either way, so
  // swapping two cells shows the wrong date under the right header — wrong data read as correct.
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

  it('separates every windowed row and stops at the list-final row, not the window-final one', () => {
    renderCollection({ items: artifacts(500) })

    const windowedRows = Array.from(
      host.querySelectorAll<HTMLElement>('[data-index] [role="button"]')
    )
    expect(windowedRows.length).toBe(16)
    for (const row of windowedRows) {
      expectRowDivider(row)
    }

    // Why: index 499 is nowhere near the first window, so only the slug comparison can find it —
    // the removed `divide-y` and any window-relative "is this the last row" check would not.
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
    // The selected class carries no border token, so a selected row keeps its own hairline — and
    // this is the only render with a selection, so the only place a `!isSelected` gate would show.
    expectRowDivider(current[0])
  })

  it('keeps every windowed row on its own slug when an artifact is prepended', () => {
    // Paired titles, distinct slugs: real artifacts can share a name, and a title key would then
    // collide inside the window and hand one artifact's row to the other.
    const base = Array.from({ length: 500 }, (_, index) =>
      artifact(`a-${index}`, `Artifact ${Math.floor(index / 2)}`)
    )
    renderCollection({ items: base })
    const before = mountCountsSnapshot()
    // More slugs mounted than the 16 on screen: first paint windows before the scroll margin is
    // measured, so it briefly fills the whole 600px viewport plus overscan. Bounded, not pinned —
    // the claim is only that the transient window stayed far short of the whole list.
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

  // The row's second menu, and the only assertion that opens it: its items are mapped from
  // `rowActions` separately from the dropdown's, so nothing else here would see them diverge.
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
    expect(selected?.classList.contains('bg-accent')).toBe(true)
    // Conditional, not unconditional: its neighbour in the same window carries no wash.
    expect(
      rowAtIndex(399)?.querySelector(ARTIFACT_ROW_SELECTOR)?.classList.contains('bg-accent')
    ).toBe(false)
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
    // Why pinned: the list-final row draws no divider of its own, so this top rule is the only
    // thing closing the table — and a deleted class is invisible to a containment check.
    expect(loadMoreBlock?.classList.contains('border-t')).toBe(true)
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

  // An empty page may still have a server cursor for another page.
  it('shows the empty state alongside Load more for an empty page', () => {
    renderCollection({ items: [], hasMore: true })

    const children = Array.from(scroller().children)
    expect(children.length).toBe(3)
    expect(children[0]).toBe(tableHeader())
    expectCenteredEmptyState()
    const loadMoreBlock = children[2]
    expect(loadMoreBlock?.textContent).toContain('Load more')
    expect(loadMoreBlock?.classList.contains('border-t')).toBe(true)
    expect(virtualShell()).toBeNull()
    expect(mountedRows.count).toBe(0)
  })
})

/**
 * Crossing the threshold is the one moment the shared scroller is attached, and on attach the
 * virtualizer writes its start offset back to it — a jump to the top unless told where the user
 * already is. The 500 -> 600 append above is virtualized on both sides, so it never sees this.
 */
describe('artifacts list windowing — crossing the virtualize threshold', () => {
  it('keeps the scroll position when Load more pushes the list over the threshold', () => {
    const loadMore = vi.fn()
    const base = artifacts(VIRTUALIZED_LIST_MIN_ROWS - 10)
    renderCollection({ items: base, hasMore: true, loadMore })
    expect(virtualShell()).toBeNull()

    // Why the bottom and not an arbitrary offset: 40 rows under a 300px header overflow a 600px
    // viewport, so Load more is only reachable from here.
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
    // 45 of 60 match, so the query takes the list below the threshold and clearing it brings the
    // list back over — the same detach and re-attach, reached without loading anything.
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

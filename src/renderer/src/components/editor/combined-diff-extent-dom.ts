import { observeElementOffset, type VirtualItem, type Virtualizer } from '@tanstack/react-virtual'
import { CombinedDiffExtent } from './combined-diff-extent'
import type { DiffSection } from './diff-section-types'
import { getCombinedDiffFocusOwner } from './combined-diff-overflow'
import {
  COMBINED_DIFF_ROW_SELECTOR,
  COMBINED_DIFF_VIEWPORT_SELECTOR
} from './combined-diff-viewport'

const prefixHeight = (viewport: HTMLElement): number =>
  viewport.querySelector('[data-combined-diff-prefix]')?.getBoundingClientRect().height ?? 0

const owners = new WeakMap<HTMLElement, ReturnType<typeof createOwner>>()

function createOwner(viewport: HTMLElement) {
  let mark: ((offset: number) => void) | undefined
  let offsetChanged: (() => void) | undefined
  let projectedLeading = 0
  let refresh: (() => void) | undefined
  const content = new Map<string, { section: DiffSection; row: HTMLElement; size: number }>()
  let contentRevision = 0
  const extent = new CombinedDiffExtent({
    position: () => viewport.scrollTop,
    height: () => viewport.clientHeight,
    scrollHeight: () => viewport.scrollHeight,
    project: (items, height, leading) => {
      const content = viewport.querySelector<HTMLElement>('[data-combined-diff-extent]')
      const prefix = prefixHeight(viewport)
      if (content) {
        content.style.height = `${Math.max(0, height - prefix)}px`
      }
      viewport.querySelectorAll<HTMLElement>(COMBINED_DIFF_ROW_SELECTOR).forEach((row) => {
        const item = items[Number(row.dataset.index)]
        if (item) {
          row.style.top = `${item.start + leading - prefix}px`
        }
      })
      if (leading !== projectedLeading) {
        projectedLeading = leading
        offsetChanged?.()
      }
    },
    write: (offset) => {
      mark?.(offset)
      viewport.scrollTop = offset
    }
  })
  return {
    extent,
    content,
    revision: () => contentRevision,
    publish: (section: DiffSection, row: HTMLElement, size: number) => {
      content.set(section.key, { section, row, size })
      contentRevision += 1
      refresh?.()
    },
    retire: (row: HTMLElement) => {
      for (const [key, geometry] of content) {
        if (geometry.row === row) {
          content.delete(key)
          contentRevision += 1
        }
      }
    },
    setRefresh: (next: typeof refresh) => {
      refresh = next
      if (!next) {
        content.clear()
        contentRevision += 1
      }
    },
    setMark: (next: typeof mark) => {
      mark = next
    },
    setOffsetChanged: (next: typeof offsetChanged) => {
      offsetChanged = next
    }
  }
}

export function observeCombinedDiffOffset(
  instance: Virtualizer<HTMLDivElement, Element>,
  callback: (offset: number, isScrolling: boolean) => void
): (() => void) | undefined {
  const viewport = instance.scrollElement
  if (!viewport) {
    return undefined
  }
  const extent = getCombinedDiffExtent(viewport)
  const notify = (scrolling: boolean): void =>
    callback(Math.max(0, extent.logicalScrollTop() - prefixHeight(viewport)), scrolling)
  owners.get(viewport)?.setOffsetChanged(() => notify(instance.isScrolling))
  const disconnect = observeElementOffset(instance, (_offset, scrolling) => {
    // Consume physical input before a virtualizer publication can reuse the old anchor.
    extent.scrolled()
    notify(scrolling)
  })
  return () => {
    disconnect?.()
    owners.get(viewport)?.setOffsetChanged(undefined)
  }
}

export function getCombinedDiffExtent(viewport: HTMLElement): CombinedDiffExtent {
  let owner = owners.get(viewport)
  if (!owner) {
    owner = createOwner(viewport)
    owners.set(viewport, owner)
  }
  return owner.extent
}

const identities = new WeakMap<
  Virtualizer<HTMLDivElement, Element>,
  {
    sections: readonly (Pick<DiffSection, 'key'> & Partial<DiffSection>)[]
    source?: readonly VirtualItem[]
    contentRevision?: number
    logical?: readonly VirtualItem[]
  }
>()

export function publishCombinedDiffMeasurements(
  instance: Virtualizer<HTMLDivElement, Element>,
  sections?: readonly (Pick<DiffSection, 'key'> & Partial<DiffSection>)[]
): void {
  let identity = identities.get(instance)
  if (sections && identity?.sections !== sections) {
    identity = { sections }
    identities.set(instance, identity)
    const keys = new Set(sections.map((section) => section.key))
    const owner = instance.scrollElement && owners.get(instance.scrollElement)
    if (owner) {
      for (const key of owner.content.keys()) {
        if (!keys.has(key)) {
          owner.content.delete(key)
        }
      }
    }
  }
  instance.shouldAdjustScrollPositionOnItemSizeChange = () => false
  const viewport = instance.scrollElement
  if (!viewport) {
    return
  }
  const active = viewport.ownerDocument.activeElement
  const row = active ? getCombinedDiffFocusOwner(active) : null
  const prefix = prefixHeight(viewport)
  instance.getTotalSize()
  const measured = instance.measurementsCache
  const owner = owners.get(viewport)
  if (
    identity &&
    (identity.source !== measured || identity.contentRevision !== owner?.revision())
  ) {
    identity.contentRevision = owner?.revision()
    identity.source = measured
    const sections = identity.sections
    identity.logical = measured.map((item) => ({
      ...item,
      key: sections[item.index]?.key ?? item.key,
      settled: isCombinedDiffSectionSettled(viewport, sections[item.index], item)
    }))
  }
  const logical = identity?.logical ?? measured
  const focused = row && viewport.contains(row) ? logical[Number(row.dataset.index)] : undefined
  getCombinedDiffExtent(viewport).publish(logical, focused?.key, prefix)
}

export function scrollCombinedDiffTo(viewport: HTMLElement, target: number): boolean {
  return getCombinedDiffExtent(viewport).navigate(target)
}

export function reconcileCombinedDiffViewport(
  instance: Virtualizer<HTMLDivElement, Element>
): void {
  publishCombinedDiffMeasurements(instance)
  const viewport = instance.scrollElement
  if (viewport) {
    getCombinedDiffExtent(viewport).scrolled()
  }
}

export function scrollCombinedDiffToIndex(
  instance: Virtualizer<HTMLDivElement, Element>,
  index: number,
  offset = 0
): void {
  publishCombinedDiffMeasurements(instance)
  const viewport = instance.scrollElement
  const item = viewport && getCombinedDiffExtent(viewport).item(index)
  if (viewport && item) {
    const owner = getCombinedDiffExtent(viewport)
    owner.restore({ key: item.key, offset, gap: 0 })
  }
}

export function connectCombinedDiffExtent(
  viewport: HTMLElement,
  mark?: (offset: number) => void,
  refresh?: () => void
): () => void {
  const extent = getCombinedDiffExtent(viewport)
  owners.get(viewport)?.setMark(mark)
  owners.get(viewport)?.setRefresh(refresh)
  const overflowAnchor = viewport.style.overflowAnchor
  viewport.style.overflowAnchor = 'none'
  const input = (): void => extent.input()
  const scroll = (): void => extent.scrolled()
  const events = ['wheel', 'touchmove', 'pointerdown'] as const
  events.forEach((event) =>
    viewport.addEventListener(event, input, { capture: true, passive: true })
  )
  viewport.addEventListener('scroll', scroll, { passive: true })
  const resize = new ResizeObserver(() => {
    refresh?.()
    scroll()
  })
  resize.observe(viewport)
  return () => {
    resize.disconnect()
    events.forEach((event) => viewport.removeEventListener(event, input, true))
    viewport.removeEventListener('scroll', scroll)
    viewport.style.overflowAnchor = overflowAnchor
    owners.get(viewport)?.setMark(undefined)
    owners.get(viewport)?.setRefresh(undefined)
    extent.dispose()
  }
}

export function publishCombinedDiffSectionGeometry(node: HTMLElement, section: DiffSection): void {
  const viewport = node.closest<HTMLElement>(COMBINED_DIFF_VIEWPORT_SELECTOR)
  const row = node.closest<HTMLElement>(COMBINED_DIFF_ROW_SELECTOR)
  if (viewport && row) {
    getCombinedDiffExtent(viewport)
    owners.get(viewport)?.publish(section, row, Math.round(row.getBoundingClientRect().height))
  }
}

export function retireCombinedDiffSectionGeometry(node: HTMLElement): void {
  const viewport = node.closest<HTMLElement>(COMBINED_DIFF_VIEWPORT_SELECTOR)
  const row = node.closest<HTMLElement>(COMBINED_DIFF_ROW_SELECTOR)
  if (viewport && row) {
    owners.get(viewport)?.retire(row)
  }
}

function isCombinedDiffSectionSettled(
  viewport: HTMLElement,
  section: (Pick<DiffSection, 'key'> & Partial<DiffSection>) | undefined,
  item: VirtualItem
): boolean {
  if (!section || section.loading === undefined) {
    return true
  }
  const geometry = owners.get(viewport)?.content.get(section.key)
  if (
    geometry &&
    geometry.size === item.size &&
    geometry.section.contentGeneration === section.contentGeneration &&
    geometry.section.originalContent === section.originalContent &&
    geometry.section.modifiedContent === section.modifiedContent
  ) {
    return !section.loading
  }
  const terminal =
    section.collapsed ||
    (!section.loading &&
      (section.error ||
        section.loadOnDemand ||
        section.largeDiffRenderLimit?.limited ||
        section.diffResult?.kind === 'binary'))
  const row =
    terminal &&
    viewport.querySelector<HTMLElement>(`${COMBINED_DIFF_ROW_SELECTOR}[data-index="${item.index}"]`)
  if (!row || Math.round(row.getBoundingClientRect().height) !== item.size) {
    return false
  }
  if (
    section.diffResult?.kind === 'binary' &&
    section.diffResult.isImage &&
    !section.diffResult.tooLarge
  ) {
    const images = Array.from(row.querySelectorAll('img'))
    return images.length > 0 && images.every((image) => image.complete)
  }
  return true
}

import {
  DIFF_SECTION_HEADER_HEIGHT,
  DIFF_SECTION_PADDING_HEIGHT
} from '../diff/sections/diff-section-layout'
import { memo, useEffect, useMemo, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { DiffSection } from '../diff/sections/diff-section-types'
import type { DiffOverviewMarker, DiffOverviewSource } from './pierre-diff-overview'

export type CombinedDiffOverview = {
  sections: DiffSection[]
  virtualizer: Virtualizer<HTMLDivElement, Element>
  sideBySide: boolean
}
const OverviewMarkers = memo(function OverviewMarkers({
  markers,
  offset,
  scale,
  scrollHeight,
  viewportHeight,
  scrollContainerRef
}: {
  markers: readonly DiffOverviewMarker[]
  offset: number
  scale: number
  scrollHeight: number
  viewportHeight: number
  scrollContainerRef: RefObject<HTMLElement | null>
}) {
  return markers.map((marker, index) => {
    const top = offset + marker.top * scale
    return (
      <div
        key={index}
        className="absolute w-1 pointer-events-auto cursor-default"
        style={{
          left: marker.side === 'deletions' ? 0 : 4,
          top: `${Math.min(100, (top / scrollHeight) * 100)}%`,
          height: `${Math.max(2, ((marker.height * scale) / scrollHeight) * (viewportHeight - 8))}px`,
          background: marker.side === 'additions' ? 'var(--diff-added)' : 'var(--diff-removed)'
        }}
        onPointerDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
          scrollContainerRef.current?.scrollTo({ top: Math.max(0, top - viewportHeight / 2) })
        }}
      />
    )
  })
})

type MarkerGroup = { key: string; markers: DiffOverviewMarker[]; offset: number; scale: number }

export const PierreDiffOverviewRuler = memo(function PierreDiffOverviewRuler({
  scrollContainerRef,
  sources,
  combined
}: {
  scrollContainerRef: RefObject<HTMLElement | null>
  sources: ReadonlyMap<string, DiffOverviewSource>
  combined?: CombinedDiffOverview
}): React.JSX.Element | null {
  const [viewport, setViewport] = useState<{
    parent: HTMLElement
    height: number
    scrollHeight: number
  } | null>(null)
  const sections = combined?.sections
  const sideBySide = combined?.sideBySide ?? false
  const totalSize = combined?.virtualizer.getTotalSize()
  const measurements = combined?.virtualizer.measurementsCache
  useEffect(() => {
    const container = scrollContainerRef.current
    const parent = container?.parentElement
    if (!container || !parent) {
      return
    }
    const update = (): void => {
      const height = container.clientHeight
      const scrollHeight = container.scrollHeight
      setViewport((previous) =>
        previous?.parent === parent &&
        previous.height === height &&
        previous.scrollHeight === scrollHeight
          ? previous
          : { parent, height, scrollHeight }
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(container)
    if (container.lastElementChild) {
      observer.observe(container.lastElementChild)
    }
    return () => observer.disconnect()
  }, [scrollContainerRef, totalSize])
  const groups = useMemo(() => {
    const result: MarkerGroup[] = []
    if (!sections) {
      for (const [key, source] of sources) {
        result.push({ key, markers: source.markers, offset: source.inset, scale: 1 })
      }
      return result
    }
    for (const [index, section] of sections.entries()) {
      const row = measurements?.[index]
      if (!row) {
        continue
      }
      const source = sources.get(section.key)
      const current =
        source?.original === section.originalContent &&
        source.modified === section.modifiedContent &&
        JSON.parse(source.layout)[0] === sideBySide
          ? source
          : undefined
      const geometry = current
      if (geometry && !section.collapsed) {
        const inset = current?.inset ?? DIFF_SECTION_HEADER_HEIGHT
        const scale = current
          ? 1
          : Math.max(0, row.size - inset - DIFF_SECTION_PADDING_HEIGHT) /
            Math.max(1, geometry.height)
        result.push({
          key: section.key,
          markers: geometry.markers,
          offset: row.start + inset,
          scale
        })
      } else {
        for (const [side, count] of [
          ['additions', section.added],
          ['deletions', section.removed]
        ] as const) {
          if (count) {
            result.push({
              key: `${section.key}:${side}`,
              markers: [{ side, top: 0, height: row.size }],
              offset: row.start,
              scale: 1
            })
          }
        }
      }
    }
    return result
  }, [sections, measurements, sources, sideBySide])
  if (!viewport || viewport.scrollHeight <= viewport.height || !groups.length) {
    return null
  }
  return createPortal(
    <div aria-hidden="true" className="absolute inset-y-1 right-3 z-30 w-2 pointer-events-none">
      {groups.map((group) => (
        <OverviewMarkers
          key={group.key}
          markers={group.markers}
          offset={group.offset}
          scale={group.scale}
          scrollHeight={viewport.scrollHeight}
          viewportHeight={viewport.height}
          scrollContainerRef={scrollContainerRef}
        />
      ))}
    </div>,
    viewport.parent
  )
})

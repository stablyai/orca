import {
  DIFF_SECTION_HEADER_HEIGHT,
  DIFF_SECTION_PADDING_HEIGHT
} from '../diff/sections/diff-section-layout'
import { memo, useEffect, useMemo, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { DiffSection } from '../diff/sections/diff-section-types'
import { requestPierreDiffMetadata } from './pierre-diff-parse-client'
import {
  estimateDiffOverview,
  type DiffOverviewGeometry,
  type DiffOverviewMarker,
  type DiffOverviewSource
} from './pierre-diff-overview'
import { buildPierreParseDiffOptions } from './pierre-diff-options'
import { useAppStore } from '@/store'

export type CombinedDiffOverview = {
  sections: DiffSection[]
  virtualizer: Virtualizer<HTMLDivElement, Element>
  sideBySide: boolean
}
type ParsedSection = {
  layout: string
  original: string
  modified: string
  geometry: DiffOverviewGeometry
}

export const PierreDiffOverviewRuler = memo(function PierreDiffOverviewRuler({
  scrollContainerRef,
  sources,
  combined
}: {
  scrollContainerRef: RefObject<HTMLElement | null>
  sources: ReadonlyMap<string, DiffOverviewSource>
  combined?: CombinedDiffOverview
}): React.JSX.Element | null {
  const whitespace = useAppStore((state) => state.settings?.diffShowWhitespace)
  const [parsed, setParsed] = useState<ReadonlyMap<string, ParsedSection>>(new Map())
  const [viewport, setViewport] = useState<{
    parent: HTMLElement
    height: number
    scrollHeight: number
  } | null>(null)
  const sections = combined?.sections
  const sideBySide = combined?.sideBySide ?? false
  const layout = JSON.stringify([sideBySide, whitespace])
  useEffect(() => {
    const controller = new AbortController()
    // Keep metadata work out of the highlight pool and its viewport admission budget.
    void (async () => {
      const next = new Map<string, ParsedSection>()
      for (const section of sections ?? []) {
        if (controller.signal.aborted) {
          return
        }
        if (
          section.loading ||
          section.loadOnDemand ||
          section.diffResult?.kind !== 'text' ||
          section.largeDiffRenderLimit?.limited
        ) {
          continue
        }
        const original = section.originalContent
        const modified = section.modifiedContent
        const previous = parsed.get(section.key)
        if (
          previous?.original === original &&
          previous.modified === modified &&
          previous.layout === layout
        ) {
          next.set(section.key, previous)
          continue
        }
        try {
          const diff = await requestPierreDiffMetadata(
            {
              path: section.path,
              oldPath: section.oldPath,
              status: section.status,
              originalContent: original,
              modifiedContent: modified,
              parseDiffOptions: buildPierreParseDiffOptions(whitespace)
            },
            controller.signal
          )
          next.set(section.key, {
            layout,
            original,
            modified,
            geometry: estimateDiffOverview(diff, sideBySide)
          })
        } catch {
          // The section-level change counts remain available if parsing fails.
        }
      }
      if (!controller.signal.aborted) {
        setParsed(next)
      }
    })()
    return () => controller.abort()
    // parsed is a previous-result cache; publishing it must not launch another pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, sideBySide, whitespace])
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
  }, [scrollContainerRef, totalSize, sources])
  const markers = useMemo(() => {
    const result: DiffOverviewMarker[] = []
    if (!sections) {
      for (const source of sources.values()) {
        result.push(
          ...source.markers.map((marker) => ({ ...marker, top: marker.top + source.inset }))
        )
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
      const snapshot = parsed.get(section.key)
      const geometry =
        current ??
        (snapshot?.original === section.originalContent &&
        snapshot.modified === section.modifiedContent
          ? snapshot.geometry
          : undefined)
      if (geometry && !section.collapsed) {
        const inset = current?.inset ?? DIFF_SECTION_HEADER_HEIGHT
        const scale = current
          ? 1
          : Math.max(0, row.size - inset - DIFF_SECTION_PADDING_HEIGHT) /
            Math.max(1, geometry.height)
        result.push(
          ...geometry.markers.map((marker) => ({
            ...marker,
            top: row.start + inset + marker.top * scale,
            height: marker.height * scale
          }))
        )
      } else {
        for (const [side, count] of [
          ['additions', section.added],
          ['deletions', section.removed]
        ] as const) {
          if (count) {
            result.push({ side, top: row.start, height: row.size })
          }
        }
      }
    }
    return result
  }, [sections, measurements, parsed, sources, sideBySide])
  if (!viewport || viewport.scrollHeight <= viewport.height || !markers.length) {
    return null
  }
  return createPortal(
    <div aria-hidden="true" className="absolute inset-y-1 right-3 z-30 w-2 pointer-events-none">
      {markers.map((marker, index) => (
        <div
          key={index}
          className="absolute w-1 pointer-events-auto cursor-default"
          style={{
            left: marker.side === 'deletions' ? 0 : 4,
            top: `${Math.min(100, (marker.top / viewport.scrollHeight) * 100)}%`,
            height: `${Math.max(2, (marker.height / viewport.scrollHeight) * (viewport.height - 8))}px`,
            background: marker.side === 'additions' ? 'var(--diff-added)' : 'var(--diff-removed)'
          }}
          onPointerDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
            scrollContainerRef.current?.scrollTo({
              top: Math.max(0, marker.top - viewport.height / 2)
            })
          }}
        />
      ))}
    </div>,
    viewport.parent
  )
})

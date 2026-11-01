import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  AttachmentTextViewport,
  type TextAnchor
} from '../../../../shared/attachment-text-viewport'
import type { AttachmentTextSource } from '../../../../shared/attachment-text-source'

export function AttachmentTextScrollView(props: {
  source: AttachmentTextSource
  revision: number
  demand: (indices: number[]) => void
}) {
  return <TextViewport key={props.source.path} {...props} />
}
function TextViewport({
  source,
  revision,
  demand
}: {
  source: AttachmentTextSource
  revision: number
  demand: (indices: number[]) => void
}) {
  const scroll = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLDivElement>(null)
  const anchor = useRef<TextAnchor>({ block: 0, row: 0 })
  const previousSource = useRef(source)
  const previousLayout = useRef<AttachmentTextViewport | null>(null)
  const atEnd = useRef(false)
  const [position, setPosition] = useState({ top: 0, height: 0, rowHeight: 20 })
  const layout = useMemo(
    () => new AttachmentTextViewport(source, position.rowHeight, position.height, revision),
    [source, revision, position.rowHeight, position.height]
  )
  const blocks = useVirtualizer({
    count: source.blockCount,
    getScrollElement: () => scroll.current,
    estimateSize: (index) => layout.heights[index]!,
    overscan: 0
  })
  useLayoutEffect(() => {
    const node = scroll.current
    if (!node) {
      return
    }
    if (previousSource.current !== source) {
      anchor.current = { block: 0, row: 0 }
      atEnd.current = false
      previousSource.current = source
    }
    const old = previousLayout.current
    if (
      old?.source === source &&
      old.revision !== layout.revision &&
      old.counts[anchor.current.block] !== layout.counts[anchor.current.block]
    ) {
      anchor.current.row *=
        (layout.counts[anchor.current.block] ?? 1) / (old.counts[anchor.current.block] ?? 1)
    }
    previousLayout.current = layout
    blocks.measure()
    node.scrollTop = atEnd.current
      ? Math.max(0, layout.total - node.clientHeight)
      : layout.position(anchor.current)
    setPosition((old) => ({ ...old, top: node.scrollTop }))
  }, [source, layout, blocks])
  useLayoutEffect(() => {
    const node = scroll.current
    if (!node) {
      return
    }
    const measure = () =>
      setPosition((old) => ({
        ...old,
        height: node.clientHeight,
        rowHeight: probe.current?.getBoundingClientRect().height || old.rowHeight
      }))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    if (probe.current) {
      observer.observe(probe.current)
    }
    return () => observer.disconnect()
  }, [])
  const block = layout.anchor(position.top).block
  // The hook already owns first paint; subsequent ranges follow the actual visible coarse item.
  const first = blocks.getVirtualItemForOffset(position.top)?.index ?? block
  const needsNext =
    source.cachedBlock(first) !== undefined &&
    (source.rowCount(first) - layout.anchor(position.top).row) * position.rowHeight <
      position.height + 4 * position.rowHeight &&
    first + 1 < source.blockCount
  useEffect(() => {
    if (source.size !== null) {
      demand(needsNext ? [first, first + 1] : [first])
    }
  }, [source, first, needsNext, demand])
  const model = useRef({ layout, position })
  model.current = { layout, position }
  useEffect(() => {
    const node = scroll.current
    if (!node) {
      return
    }
    const move = (pixels: number) => {
      const { layout } = model.current
      node.scrollTop = layout.move(layout.anchor(node.scrollTop), pixels)
    }
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        return
      }
      event.preventDefault()
      move(
        event.deltaY *
          (event.deltaMode === 1
            ? model.current.position.rowHeight
            : event.deltaMode === 2
              ? node.clientHeight
              : 1)
      )
    }
    node.addEventListener('wheel', wheel, { passive: false })
    return () => node.removeEventListener('wheel', wheel)
  }, [])
  return (
    <div
      ref={scroll}
      tabIndex={0}
      className="scrollbar-editor min-h-0 flex-1 overflow-auto px-4"
      onKeyDown={(event) => {
        const node = event.currentTarget
        const pixels =
          event.key === 'ArrowDown'
            ? position.rowHeight
            : event.key === 'ArrowUp'
              ? -position.rowHeight
              : event.key === 'PageDown' || event.key === ' '
                ? node.clientHeight
                : event.key === 'PageUp'
                  ? -node.clientHeight
                  : null
        if (pixels !== null) {
          event.preventDefault()
          node.scrollTop = layout.move(layout.anchor(node.scrollTop), pixels)
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          node.scrollTop = event.key === 'Home' ? 0 : layout.total
        }
      }}
      onScroll={(event) => {
        const node = event.currentTarget
        anchor.current = layout.anchor(node.scrollTop)
        atEnd.current = node.scrollTop > 0 && node.scrollTop + node.clientHeight >= layout.total - 1
        setPosition((old) => ({ ...old, top: node.scrollTop }))
      }}
    >
      <div
        ref={probe}
        aria-hidden
        className="pointer-events-none absolute invisible whitespace-pre font-mono text-sm"
      >
        M
      </div>
      <div style={{ height: blocks.getTotalSize(), position: 'relative', minWidth: 'max-content' }}>
        {layout.rows(position.top).map((row) => (
          <div
            key={row.key}
            data-text-segment
            className="whitespace-pre font-mono text-sm"
            style={{ position: 'absolute', top: row.top, height: position.rowHeight }}
          >
            {row.text.replace(/\n$/, '') || '\u00a0'}
          </div>
        ))}
      </div>
    </div>
  )
}

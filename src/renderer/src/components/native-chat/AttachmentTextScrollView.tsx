import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AttachmentTextViewport } from '../../../../shared/attachment-text-viewport'
import type {
  AttachmentTextSource,
  AttachmentTextWindow
} from '../../../../shared/attachment-text-source'

export function AttachmentTextScrollView(props: {
  source: AttachmentTextSource
  revision: number
  demand: (window: AttachmentTextWindow) => void
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
  demand: (window: AttachmentTextWindow) => void
}) {
  const scroll = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ height: 0, rowHeight: 20, cellWidth: 8 })
  const measured = useMemo(
    () => new AttachmentTextViewport(source, position.rowHeight, position.height, revision),
    [source, revision, position.rowHeight, position.height]
  )
  const [projection, setProjection] = useState(() => ({ layout: measured, top: 0 }))
  const { layout } = projection
  // Keep the old host extent until its live position has been read, before the next track can clamp it.
  useLayoutEffect(() => {
    if (layout !== measured) {
      const live = scroll.current?.scrollTop ?? projection.top
      setProjection({ layout: measured, top: measured.restore(layout, live) })
    }
  }, [measured, layout, projection.top])
  useLayoutEffect(() => {
    const node = scroll.current
    if (!node) {
      return
    }
    if (Math.abs(node.scrollTop - projection.top) / layout.scale > 0.01) {
      node.scrollTop = projection.top
    }
    setProjection((old) => (old.top === node.scrollTop ? old : { ...old, top: node.scrollTop }))
  }, [layout])
  useLayoutEffect(() => {
    const node = scroll.current
    if (!node) {
      return
    }
    const measure = () => {
      const height = node.clientHeight
      const cell = probe.current?.getBoundingClientRect()
      setPosition((old) => ({
        ...old,
        height,
        rowHeight: cell?.height || old.rowHeight,
        cellWidth: cell?.width || old.cellWidth
      }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    if (probe.current) {
      observer.observe(probe.current)
    }
    return () => observer.disconnect()
  }, [])
  const window = layout.window(projection.top)
  useEffect(() => {
    if (source.size !== null) {
      demand(window)
    }
  }, [source, demand, window.block, window.row, window.rows, window.fraction, window.tail])
  const model = useRef({ layout, position })
  useLayoutEffect(() => {
    model.current = { layout, position }
  })
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
        setProjection((old) => ({ ...old, top: node.scrollTop }))
      }}
    >
      <div
        ref={probe}
        aria-hidden
        className="pointer-events-none absolute invisible whitespace-pre font-mono text-sm"
      >
        M
      </div>
      <div
        style={{
          height: layout.total,
          position: 'relative',
          minWidth: source.displayUnits * position.cellWidth
        }}
      >
        {layout.rows(projection.top).map((row) => (
          <div
            key={row.key}
            data-text-segment
            className="whitespace-pre font-mono text-sm"
            style={{ position: 'absolute', top: row.top, height: layout.rowHeight }}
          >
            {row.text.replace(/\n$/, '') || '\u00a0'}
          </div>
        ))}
      </div>
    </div>
  )
}

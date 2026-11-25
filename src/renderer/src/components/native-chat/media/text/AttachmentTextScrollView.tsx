import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { AttachmentTextViewport } from '../../../../../../shared/attachment-text/attachment-text-viewport'
import type {
  AttachmentTextSource,
  AttachmentTextWindow
} from '../../../../../../shared/attachment-text/attachment-text-source'

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
  const viewport = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({
    rowHeight: 20,
    cellWidth: 8,
    style: {
      height: '0px',
      width: '0px',
      fontFamily: '',
      fontSize: '',
      fontWeight: '',
      fontStyle: '',
      lineHeight: '',
      letterSpacing: '',
      paddingLeft: '',
      paddingRight: ''
    }
  })
  const [projection, setProjection] = useState(() => ({
    layout: new AttachmentTextViewport(source, position.rowHeight, 0, revision),
    top: 0,
    position,
    contentWidth: 0
  }))
  const { layout } = projection
  // Capture live source position before any host or content change can alter its usable client bounds.
  useLayoutEffect(() => {
    const node = scroll.current
    const content = track.current
    if (
      !node ||
      !content ||
      (projection.position === position && layout.source === source && layout.revision === revision)
    ) {
      return
    }
    const live = node.scrollTop
    const contentWidth = source.displayUnits * position.cellWidth
    Object.assign(node.style, position.style)
    content.style.minWidth = `${contentWidth}px`
    const next = new AttachmentTextViewport(source, position.rowHeight, node.clientHeight, revision)
    setProjection({ layout: next, top: next.restore(layout, live), position, contentWidth })
  }, [source, revision, position, projection, layout])
  const correctCommittedScroll = useEffectEvent(() => {
    const node = scroll.current
    if (!node) {
      return
    }
    if (Math.abs(node.scrollTop - projection.top) / layout.scale > 0.01) {
      node.scrollTop = projection.top
    }
    setProjection((old) => (old.top === node.scrollTop ? old : { ...old, top: node.scrollTop }))
  })
  useLayoutEffect(() => {
    correctCommittedScroll()
  }, [layout])
  useLayoutEffect(() => {
    const node = viewport.current
    if (!node) {
      return
    }
    const measure = () => {
      const cell = probe.current
      if (!cell) {
        return
      }
      const bounds = cell.getBoundingClientRect()
      const computed = getComputedStyle(cell)
      const style = {
        height: `${node.clientHeight}px`,
        width: `${node.clientWidth}px`,
        fontFamily: computed.fontFamily,
        fontSize: computed.fontSize,
        fontWeight: computed.fontWeight,
        fontStyle: computed.fontStyle,
        lineHeight: computed.lineHeight,
        letterSpacing: computed.letterSpacing,
        paddingLeft: computed.paddingLeft,
        paddingRight: computed.paddingRight
      }
      setPosition((old) => {
        const rowHeight = bounds.height || old.rowHeight
        const cellWidth =
          bounds.width -
            (Number.parseFloat(style.paddingLeft) || 0) -
            (Number.parseFloat(style.paddingRight) || 0) || old.cellWidth
        return old.rowHeight === rowHeight &&
          old.cellWidth === cellWidth &&
          old.style.height === style.height &&
          old.style.width === style.width &&
          old.style.fontFamily === style.fontFamily &&
          old.style.fontSize === style.fontSize &&
          old.style.fontWeight === style.fontWeight &&
          old.style.fontStyle === style.fontStyle &&
          old.style.lineHeight === style.lineHeight &&
          old.style.letterSpacing === style.letterSpacing &&
          old.style.paddingLeft === style.paddingLeft &&
          old.style.paddingRight === style.paddingRight
          ? old
          : { rowHeight, cellWidth, style }
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    if (scroll.current) {
      observer.observe(scroll.current)
    }
    if (probe.current) {
      observer.observe(probe.current)
    }
    return () => observer.disconnect()
  }, [])
  const { block, row, rows, fraction, tail } = layout.window(projection.top)
  useEffect(() => {
    if (source.size !== null) {
      demand({
        block,
        row,
        rows,
        ...(fraction === undefined ? {} : { fraction }),
        ...(tail === undefined ? {} : { tail })
      })
    }
  }, [source, demand, block, row, rows, fraction, tail])
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
    <div ref={viewport} className="min-h-0 flex-1 overflow-hidden">
      <div
        ref={probe}
        aria-hidden
        className="pointer-events-none absolute invisible whitespace-pre px-4 font-mono text-sm"
      >
        M
      </div>
      <div
        ref={scroll}
        tabIndex={0}
        className="scrollbar-editor overflow-auto whitespace-pre font-mono text-sm"
        style={projection.position.style}
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
          ref={track}
          style={{
            height: layout.total,
            overflow: 'clip',
            position: 'relative',
            minWidth: projection.contentWidth
          }}
        >
          {layout.rows(projection.top).map((row) => (
            <div
              key={row.key}
              data-text-segment
              className="whitespace-pre"
              style={{ position: 'absolute', top: row.top, height: layout.rowHeight }}
            >
              {row.text.replace(/\n$/, '') || '\u00a0'}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

import React, { useEffect, useRef, useState } from 'react'
import { MIN_COLUMN_WIDTH } from './column-widths'
import { translate } from '@/i18n/i18n'

type PairProps = {
  mode?: 'pair'
  nextFieldId: string
  nextWidth: number
  onResize: (fieldId: string, width: number, nextFieldId: string, nextWidth: number) => void
}

/** Pixel widths, one column at a time: the table grows and scrolls, as ADO's backlog grid does. */
type SingleProps = {
  mode: 'single'
  onResize: (fieldId: string, width: number) => void
}

type Props = {
  fieldId: string
  currentWidth: number
  minWidth?: number
  /** Fired once per drag on mouse-up; the place to persist what `onResize` streamed. */
  onResizeEnd?: () => void
} & (PairProps | SingleProps)

// Redistribute the pair’s stored width total using its measured pixel split; the first two columns use pixels, later columns use fr.
export default function ColumnResizeHandle(props: Props): React.JSX.Element {
  const { currentWidth } = props
  const minWidth = props.minWidth ?? MIN_COLUMN_WIDTH
  const [dragging, setDragging] = useState(false)
  const handleRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{
    startX: number
    startPxA: number
    startPxB: number
    totalFr: number
  } | null>(null)
  // Why: the drag listeners are bound once per drag; reading props through a ref keeps them current.
  const propsRef = useRef(props)
  propsRef.current = props

  useEffect(() => {
    if (!dragging) {
      return
    }
    const onMove = (e: MouseEvent): void => {
      const drag = dragRef.current
      const current = propsRef.current
      if (!drag) {
        return
      }
      const proposedPxA = drag.startPxA + (e.clientX - drag.startX)
      if (current.mode === 'single') {
        current.onResize(current.fieldId, Math.max(minWidth, proposedPxA))
        return
      }
      const totalPx = drag.startPxA + drag.startPxB
      if (totalPx <= 0) {
        return
      }
      const newPxA = Math.max(minWidth, Math.min(totalPx - minWidth, proposedPxA))
      const newFrA = (drag.totalFr * newPxA) / totalPx
      const newFrB = drag.totalFr - newFrA
      current.onResize(current.fieldId, newFrA, current.nextFieldId, newFrB)
    }
    const onUp = (): void => {
      dragRef.current = null
      setDragging(false)
      propsRef.current.onResizeEnd?.()
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    const prevCursor = document.body.style.cursor
    const prevSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevSelect
    }
  }, [dragging, minWidth])

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="vertical"
      aria-label={translate(
        'auto.components.github.project.ColumnResizeHandle.1304289353',
        'Resize column'
      )}
      onMouseDown={(e) => {
        if (e.button !== 0) {
          return
        }
        const cell = handleRef.current?.parentElement
        const nextCell = cell?.nextElementSibling as HTMLElement | null
        if (!cell || (props.mode !== 'single' && !nextCell)) {
          return
        }
        e.preventDefault()
        e.stopPropagation()
        dragRef.current = {
          startX: e.clientX,
          // Why (single): the rendered width may exceed the stored one (a flex title column);
          // starting from what the user sees keeps the handle under the cursor.
          startPxA: props.mode === 'single' ? cell.offsetWidth || currentWidth : cell.offsetWidth,
          startPxB: props.mode === 'single' ? 0 : (nextCell?.offsetWidth ?? 0),
          totalFr: props.mode === 'single' ? 0 : currentWidth + props.nextWidth
        }
        setDragging(true)
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      style={{
        position: 'absolute',
        right: '-6px',
        top: 0,
        height: '100%',
        width: '12px',
        cursor: 'col-resize',
        userSelect: 'none',
        zIndex: 30,
        background: dragging ? 'rgba(59,130,246,0.25)' : 'transparent'
      }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLDivElement).style.background = 'rgba(59,130,246,0.25)'
      }}
      onMouseLeave={(e) => {
        if (!dragging) {
          ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
        }
      }}
    />
  )
}

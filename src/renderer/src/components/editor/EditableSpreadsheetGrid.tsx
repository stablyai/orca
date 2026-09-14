import React, { useEffect, useMemo, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type {
  SpreadsheetCell,
  SpreadsheetRow
} from '../../../../shared/spreadsheet/spreadsheet-data'

const ROW_HEIGHT = 28
const OVERSCAN = 12
const MIN_COL_PX = 80
const MAX_COL_PX = 320
const ROW_NUMBER_COL_PX = 48
const CHAR_PX = 7

export function EditableSheetGrid({
  rows,
  readonly,
  scrollRef,
  onCellChange
}: {
  rows: SpreadsheetRow[]
  readonly: boolean
  scrollRef: React.RefObject<HTMLDivElement | null>
  onCellChange: (row: number, col: number, value: string) => void
}): React.JSX.Element {
  const columnCount = useMemo(() => {
    let max = 0
    for (const row of rows) {
      if (row.length > max) {
        max = row.length
      }
    }
    return Math.max(max, 1)
  }, [rows])

  const columnWidths = useMemo(() => {
    const widths = Array.from<number>({ length: columnCount }).fill(MIN_COL_PX)
    const consider = (cell: SpreadsheetCell | undefined, idx: number): void => {
      if (cell === null || cell === undefined) {
        return
      }
      const w = Math.min(MAX_COL_PX, Math.max(MIN_COL_PX, String(cell).length * CHAR_PX + 24))
      if (w > widths[idx]!) {
        widths[idx] = w
      }
    }
    const sampleLimit = Math.min(rows.length, 200)
    for (let r = 0; r < sampleLimit; r += 1) {
      const row = rows[r]!
      for (let c = 0; c < row.length; c += 1) {
        consider(row[c], c)
      }
    }
    return widths
  }, [rows, columnCount])

  const gridTemplate = useMemo(
    () => `${ROW_NUMBER_COL_PX}px ${columnWidths.map((w) => `${w}px`).join(' ')}`,
    [columnWidths]
  )

  const virtualizer = useVirtualizer({
    count: Math.max(rows.length, 1),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    getItemKey: (index) => index
  })

  const virtualRows = virtualizer.getVirtualItems()
  const totalHeight = virtualizer.getTotalSize()

  return (
    <div
      ref={scrollRef}
      className="relative h-full min-h-0 overflow-auto scrollbar-editor font-mono text-xs"
    >
      <div role="table" className="inline-block min-w-full" style={{ width: 'max-content' }}>
        <div
          role="row"
          className="sticky top-0 z-10 grid bg-muted/90 backdrop-blur"
          style={{ gridTemplateColumns: gridTemplate, height: ROW_HEIGHT }}
        >
          <div
            role="columnheader"
            className="sticky left-0 z-20 flex items-center justify-end border-b border-r border-border/60 bg-muted/90 px-2 text-[10px] font-normal text-muted-foreground"
          >
            #
          </div>
          {Array.from({ length: columnCount }).map((_, c) => (
            <div
              role="columnheader"
              key={c}
              className="flex items-center overflow-hidden border-b border-r border-border/60 px-2 font-medium text-foreground"
            >
              <span className="truncate">{colLabel(c)}</span>
            </div>
          ))}
        </div>
        <div style={{ height: Math.max(totalHeight, ROW_HEIGHT), position: 'relative' }}>
          {virtualRows.map((vr) => {
            const row = rows[vr.index] ?? []
            return (
              <div
                role="row"
                key={vr.key}
                data-index={vr.index}
                className="group grid hover:bg-accent/40"
                style={{
                  gridTemplateColumns: gridTemplate,
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  height: ROW_HEIGHT,
                  transform: `translateY(${vr.start}px)`
                }}
              >
                <div
                  role="rowheader"
                  className="sticky left-0 z-[5] flex items-center justify-end border-b border-r border-border/40 bg-background/95 px-2 text-[10px] text-muted-foreground group-hover:bg-accent/40"
                >
                  {vr.index + 1}
                </div>
                {Array.from({ length: columnCount }).map((_, c) => (
                  <CellInput
                    key={c}
                    value={cellToString(row[c])}
                    readonly={readonly}
                    onChange={(value) => onCellChange(vr.index, c, value)}
                  />
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function CellInput({
  value,
  readonly,
  onChange
}: {
  value: string
  readonly: boolean
  onChange: (value: string) => void
}): React.JSX.Element {
  const [text, setText] = useState(value)
  useEffect(() => {
    setText(value)
  }, [value])
  return (
    <input
      role="cell"
      type="text"
      readOnly={readonly}
      value={text}
      onChange={(e) => {
        const next = e.target.value
        setText(next)
        onChange(next)
      }}
      className="h-full w-full border-b border-r border-border/40 bg-transparent px-2 text-foreground outline-none focus:bg-accent/40 focus:outline-none disabled:opacity-70"
    />
  )
}

function cellToString(cell: SpreadsheetCell | undefined): string {
  if (cell === null || cell === undefined) {
    return ''
  }
  if (typeof cell === 'boolean') {
    return cell ? 'TRUE' : 'FALSE'
  }
  return String(cell)
}

function colLabel(index: number): string {
  let label = ''
  let n = index
  do {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return label
}

import React, { useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { detectCsvDelimiter, parseCsv } from './csv-parse'

type CsvViewerProps = {
  content: string
  filePath: string
}

const ROW_HEIGHT = 28
const OVERSCAN = 12
const MIN_COL_PX = 80
const MAX_COL_PX = 320
const ROW_NUMBER_COL_PX = 48
const CHAR_PX = 7

// Why: CsvViewer is the table counterpart to source-mode Monaco for .csv/.tsv
// files. Row virtualization via @tanstack/react-virtual keeps large files
// (100k+ rows) responsive. We use CSS grid with a shared grid-template-columns
// rather than a <table>, because absolutely-positioned virtualized rows break
// a table's column-width synchronization — the header would size itself
// independently of the body, leaving values squashed together.
export default function CsvViewer({ content, filePath }: CsvViewerProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)

  const parsed = useMemo(() => {
    const delimiter = detectCsvDelimiter(filePath, content)
    return parseCsv(content, delimiter)
  }, [content, filePath])

  // Why: memoize header/body split so their references stay stable across
  // renders that don't change content. A top-level rest-destructure would
  // slice the full rows array (100k+ on large files) on every render and
  // produce a new `bodyRows` reference, invalidating the downstream
  // `columnWidths`/`gridTemplate` memos below.
  const { headerRow, bodyRows } = useMemo(() => {
    if (parsed.rows.length === 0) {
      return { headerRow: [] as string[], bodyRows: [] as string[][] }
    }
    const [head, ...rest] = parsed.rows
    return { headerRow: head ?? [], bodyRows: rest }
  }, [parsed])
  const columnCount = parsed.maxColumns
  const header = useMemo(() => {
    const out = [...(headerRow ?? [])]
    while (out.length < columnCount) {
      out.push('')
    }
    return out
  }, [headerRow, columnCount])

  // Why: size each column to its widest-seen value (sampled) so headers and
  // body cells stay aligned. We cap sampling to the first 200 rows to avoid
  // scanning huge files; uncommon long values clip with ellipsis rather than
  // blowing out the viewport width.
  const columnWidths = useMemo(() => {
    const widths = Array.from<number>({ length: columnCount }).fill(MIN_COL_PX)
    const consider = (cell: string | undefined, idx: number): void => {
      if (!cell) {
        return
      }
      const w = Math.min(MAX_COL_PX, Math.max(MIN_COL_PX, cell.length * CHAR_PX + 24))
      if (w > widths[idx]!) {
        widths[idx] = w
      }
    }
    header.forEach(consider)
    const sampleLimit = Math.min(bodyRows.length, 200)
    for (let i = 0; i < sampleLimit; i += 1) {
      const row = bodyRows[i]!
      for (let c = 0; c < columnCount; c += 1) {
        consider(row[c], c)
      }
    }
    return widths
  }, [header, bodyRows, columnCount])

  const gridTemplate = useMemo(
    () => `${ROW_NUMBER_COL_PX}px ${columnWidths.map((w) => `${w}px`).join(' ')}`,
    [columnWidths]
  )

  const virtualizer = useVirtualizer({
    count: bodyRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    getItemKey: (index) => index
  })

  if (parsed.rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Empty file
      </div>
    )
  }

  const virtualRows = virtualizer.getVirtualItems()
  const totalHeight = virtualizer.getTotalSize()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-auto scrollbar-editor font-mono text-xs"
      >
        <div
          role="table"
          aria-rowcount={parsed.rows.length}
          aria-colcount={columnCount + 1}
          className="inline-block min-w-full"
          style={{ width: 'max-content' }}
        >
          <div
            role="row"
            aria-rowindex={1}
            className="sticky top-0 z-10 grid bg-muted/90 backdrop-blur"
            style={{ gridTemplateColumns: gridTemplate, height: ROW_HEIGHT }}
          >
            <div
              role="columnheader"
              className="sticky left-0 z-20 flex items-center justify-end border-b border-r border-border/60 bg-muted/90 px-2 text-[10px] font-normal text-muted-foreground"
            >
              #
            </div>
            {header.map((cell, idx) => (
              <div
                role="columnheader"
                key={idx}
                className="flex items-center overflow-hidden border-b border-r border-border/60 px-2 font-medium text-foreground"
              >
                <span className="truncate" title={cell}>
                  {cell}
                </span>
              </div>
            ))}
          </div>
          <div style={{ height: totalHeight, position: 'relative' }}>
            {virtualRows.map((vr) => {
              const row = bodyRows[vr.index] ?? []
              return (
                <div
                  role="row"
                  aria-rowindex={vr.index + 2}
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
                  {Array.from({ length: columnCount }).map((_, colIdx) => (
                    <div
                      role="cell"
                      key={colIdx}
                      className="flex items-center overflow-hidden border-b border-r border-border/40 px-2 text-foreground"
                      title={row[colIdx] ?? ''}
                    >
                      <span className="truncate">{row[colIdx] ?? ''}</span>
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-4 border-t border-border/60 px-3 py-1 text-xs text-muted-foreground">
        <span>{bodyRows.length.toLocaleString()} rows</span>
        <span>{columnCount} columns</span>
      </div>
    </div>
  )
}

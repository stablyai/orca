import { useVirtualizer } from '@tanstack/react-virtual'

// Why: below this count plain rows keep the DOM identical to the pre-virtualization markup, so the
// common shallow-history case keeps exact scrollbar and flicker-free behavior. Matches the
// threshold the file lists use for the same reason.
export const GIT_HISTORY_VIRTUALIZE_MIN_ROWS = 50
// Why: a collapsed commit row is one 26px line. Expanded rows carry a file list and are far
// taller, so estimate the collapsed height and let measureElement correct the expanded ones.
export const GIT_HISTORY_ROW_HEIGHT_PX = 26
export const GIT_HISTORY_ROW_OVERSCAN = 8

/**
 * Windows the commit rows inside the history panel's own scroller.
 *
 * Unlike the file lists, this list *is* the scroll container, so there is no offset to measure
 * against a shared scroller and no scroll margin to subtract.
 */
export function GitHistoryVirtualRows<TRow>({
  rows,
  getRowKey,
  renderRow,
  scrollElement
}: {
  rows: readonly TRow[]
  getRowKey: (row: TRow) => string
  renderRow: (row: TRow) => React.ReactNode
  // Why: a state-held element, not a ref — the scroller is this component's own ancestor and is
  // not attached when mount effects run, so a ref would leave the virtualizer unobserved.
  scrollElement: HTMLDivElement | null
}): React.JSX.Element {
  const virtualize = rows.length >= GIT_HISTORY_VIRTUALIZE_MIN_ROWS

  const virtualizer = useVirtualizer({
    count: rows.length,
    enabled: virtualize && scrollElement !== null,
    getScrollElement: () => scrollElement,
    estimateSize: () => GIT_HISTORY_ROW_HEIGHT_PX,
    overscan: GIT_HISTORY_ROW_OVERSCAN,
    // Why: measured row heights are cached against this key. Positions are not stable identity —
    // a refresh or base-ref change puts different commits at the same indices, and an index key
    // would hand a new commit the measured height of whatever expanded row used to sit there.
    // (Expansion itself survives a page append because the panel keys that state by commit id.)
    getItemKey: (index) => {
      const row = rows[index]
      return row === undefined ? index : getRowKey(row)
    }
  })

  if (!virtualize) {
    return <>{rows.map((row) => renderRow(row))}</>
  }

  return (
    <div
      data-testid="git-history-virtual-list"
      className="relative w-full"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const row = rows[item.index]
        if (row === undefined) {
          return null
        }
        return (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={item.index}
            className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            {renderRow(row)}
          </div>
        )
      })}
    </div>
  )
}

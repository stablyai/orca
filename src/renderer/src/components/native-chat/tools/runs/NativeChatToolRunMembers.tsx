import { Fragment, memo, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { VIRTUALIZED_LIST_MIN_ROWS } from '@/components/ui/virtualized-list'
import { setWithLRU } from '@/components/editor/model-lifetime/retention/editor-view-state-cache'
import { NativeChatDisclosureContext } from '../../messages/disclosure/native-chat-disclosure-store'
import { NativeChatTranscriptScrollContext } from '../../viewport/scroll/native-chat-transcript-scroll-context'
import { NativeChatToolRunWindowContext } from './native-chat-tool-run-window-context'
import { observeNativeChatToolRunOffset } from './observe-native-chat-tool-run-offset'
import type { NativeChatToolRunRow } from './native-chat-tool-run-rows'
import { useNativeChatToolRunPins } from './use-native-chat-tool-run-pins'
import {
  useNativeChatToolRunWindow,
  type NativeChatToolRunDrawnRow
} from './use-native-chat-tool-run-window'

const WindowRow = memo(function WindowRow({
  row,
  renderRow
}: {
  row: NativeChatToolRunRow
  renderRow: (row: NativeChatToolRunRow) => React.ReactNode
}): React.ReactNode {
  return renderRow(row)
})

const WindowRows = memo(function WindowRows({
  drawn,
  rows,
  renderRow,
  measureRow
}: {
  drawn: readonly NativeChatToolRunDrawnRow[]
  rows: readonly NativeChatToolRunRow[]
  renderRow: (row: NativeChatToolRunRow) => React.ReactNode
  measureRow?: (node: HTMLDivElement | null) => void
}): React.ReactNode {
  const children: React.ReactNode[] = []
  let previousEnd = 0
  for (const { index, start, end } of drawn) {
    const row = rows[index]
    if (!row) {
      continue
    }
    children.push(
      <Fragment key={row.key}>
        {start > previousEnd + 0.5 ? (
          <div aria-hidden style={{ height: start - previousEnd }} />
        ) : null}
        <div ref={measureRow} data-index={index} data-native-chat-tool-run-row={row.key}>
          <WindowRow row={row} renderRow={renderRow} />
        </div>
      </Fragment>
    )
    previousEnd = Math.max(previousEnd, end)
  }
  return children
})

export function NativeChatToolRunMembers({
  rows,
  renderRow,
  measurementKey,
  revealRowKey
}: {
  rows: readonly NativeChatToolRunRow[]
  renderRow: (row: NativeChatToolRunRow) => React.ReactNode
  measurementKey?: string
  revealRowKey?: string
}): React.JSX.Element {
  const membersRef = useRef<HTMLDivElement | null>(null)
  const transcriptScroll = useContext(NativeChatTranscriptScrollContext)
  const measurements = useContext(NativeChatDisclosureContext)?.toolRunMeasurements
  const [initialMeasurementsCache] = useState(() =>
    measurementKey === undefined ? undefined : measurements?.get(measurementKey)
  )
  const { isVisible, findActive } = useContext(NativeChatToolRunWindowContext)
  const canWindow = transcriptScroll !== null && rows.length >= VIRTUALIZED_LIST_MIN_ROWS
  const drawsEveryRow = !canWindow || findActive
  const rowIndexByKey = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows])
  const { rangeExtractor, retainInteractedRow, onFocusCapture, onBlurCapture } =
    useNativeChatToolRunPins({
      rows,
      rowIndexByKey,
      revealRowKey,
      drawsEveryRow,
      tracksSelection: isVisible && transcriptScroll !== null,
      membersRef
    })
  const {
    virtualizer,
    measureRow,
    totalSize,
    drawn,
    drawsEveryRow: drawsAll
  } = useNativeChatToolRunWindow({
    rows,
    // The transcript DOM is already available when a run opens on the same commit.
    getScrollElement: () =>
      membersRef.current?.closest<HTMLDivElement>('[data-native-chat-scroll]') ?? null,
    transcript: transcriptScroll
      ? {
          ...transcriptScroll,
          observeOffset: (instance, onOffset) =>
            observeNativeChatToolRunOffset(membersRef.current, instance, onOffset)
        }
      : undefined,
    initialMeasurementsCache,
    isVisible,
    drawsEveryRow,
    rangeExtractor,
    enabled: canWindow
  })
  useLayoutEffect(
    () => () => {
      if (measurements && measurementKey !== undefined) {
        const snapshot = virtualizer.takeSnapshot()
        if (snapshot.length > 0) {
          setWithLRU(measurements, measurementKey, snapshot)
        }
      }
    },
    [measurements, measurementKey, virtualizer]
  )
  const trailing = drawsAll ? 0 : totalSize - (drawn.at(-1)?.end ?? 0)

  return (
    <div
      ref={membersRef}
      className="relative ml-1.75 mt-0.5 border-l border-chat-code-border pl-3.25"
      data-native-chat-tool-run-members
      onClickCapture={retainInteractedRow}
      onKeyDownCapture={retainInteractedRow}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
    >
      <WindowRows
        drawn={drawn}
        rows={rows}
        renderRow={renderRow}
        measureRow={canWindow ? measureRow : undefined}
      />
      {trailing > 0.5 ? <div aria-hidden style={{ height: trailing }} /> : null}
    </div>
  )
}

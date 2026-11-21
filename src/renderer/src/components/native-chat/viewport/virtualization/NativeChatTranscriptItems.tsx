import { Fragment, useMemo } from 'react'
import {
  NativeChatTranscriptRow,
  type NativeChatTranscriptRowContext
} from '../../messages/rows/NativeChatTranscriptRow'
import { nativeChatSlotKey } from '../../conversation/slots/native-chat-transcript-slot-selection'
import type { NativeChatTranscriptSlot } from '../../conversation/slots/native-chat-transcript-slots'
import { nativeChatSlotLeavesWhole } from '../../conversation/slots/native-chat-quiet-turn-rows'
import { nativeChatSlotJoinsNotesAbove } from '../../bot-items/native-chat-bot-item-note-clusters'
import {
  useNativeChatTimedRows,
  type NativeChatTimedRow
} from '../../conversation/slots/native-chat-timed-rows'
import type { NativeChatTranscriptWindow } from './use-native-chat-transcript-window'
import type { NativeChatNewRowsMarkerState } from '../new-rows/native-chat-new-rows-marker'
import {
  NativeChatReplyRevealsContext,
  useNativeChatReplyReveals
} from '../../markdown/native-chat-reply-reveals'

/** Mounted rows own their height; only unloaded gaps use cached measurements. */
export function NativeChatTranscriptItems({
  slots,
  timedRows,
  loadedMessageIds,
  context,
  window,
  newRowsMarker
}: {
  slots: readonly NativeChatTranscriptSlot[]
  /** Rows from outside the conversation, each drawn after the message it followed in time. */
  timedRows?: readonly NativeChatTimedRow[]
  loadedMessageIds: ReadonlySet<string>
  context: NativeChatTranscriptRowContext
  window: NativeChatTranscriptWindow
  newRowsMarker?: NativeChatNewRowsMarkerState
}): React.JSX.Element {
  const rowKeys = useMemo(() => slots.map(nativeChatSlotKey), [slots])
  const replyReveals = useNativeChatReplyReveals(rowKeys, loadedMessageIds)
  const placed = useNativeChatTimedRows(slots, timedRows)
  const rowContext = useMemo(
    () => (placed ? { ...context, timedRows: placed.afterMessage } : context),
    [context, placed]
  )
  return (
    <NativeChatReplyRevealsContext.Provider value={replyReveals}>
      <div ref={window.sizerRef} data-native-chat-window className="relative w-full">
        {window.virtualItems.map((item, position) => {
          const slot = slots[item.index]
          if (!slot) {
            return null
          }
          const previousEnd = window.virtualItems[position - 1]?.end ?? window.scrollMargin
          const leavesWhole = nativeChatSlotLeavesWhole(slot)
          return (
            <Fragment key={item.key}>
              <div aria-hidden style={{ height: Math.max(0, item.start - previousEnd) }} />
              {/* A leaving row's negative top margin passes through to close the gap before it. */}
              <div
                data-index={item.index}
                ref={window.measureRow}
                className={leavesWhole ? 'w-full' : 'flow-root w-full'}
              >
                <NativeChatTranscriptRow
                  slot={slot}
                  context={rowContext}
                  newRowsMarker={
                    rowKeys[item.index] === newRowsMarker?.key ? newRowsMarker : undefined
                  }
                  newRowsMarkerBelow={
                    newRowsMarker?.place === 'above-row' &&
                    rowKeys[item.index + 1] === newRowsMarker.key
                  }
                  joinsNotesAbove={nativeChatSlotJoinsNotesAbove({
                    slot,
                    previous: slots[item.index - 1],
                    timedRowsAfter: placed?.afterMessage,
                    markerKey: newRowsMarker?.key,
                    leavesWhole
                  })}
                />
              </div>
            </Fragment>
          )
        })}
        <div
          aria-hidden
          style={{
            height: Math.max(
              0,
              window.totalSize -
                ((window.virtualItems.at(-1)?.end ?? window.scrollMargin) - window.scrollMargin)
            )
          }}
        />
      </div>
      {placed?.unplaced.map(({ key, node }) => (
        <div key={key}>{node}</div>
      ))}
    </NativeChatReplyRevealsContext.Provider>
  )
}

/** Rows drawn after the live turn's activity, outside the window: few, and the newest there are. */
export function NativeChatWaitingTranscriptItems({
  slots,
  context
}: {
  slots: readonly NativeChatTranscriptSlot[]
  context: NativeChatTranscriptRowContext
}): React.JSX.Element {
  return (
    <>
      {slots.map((slot, index) => (
        <NativeChatTranscriptRow
          key={nativeChatSlotKey(slot)}
          slot={slot}
          context={context}
          joinsNotesAbove={nativeChatSlotJoinsNotesAbove({
            slot,
            previous: slots[index - 1],
            timedRowsAfter: context.timedRows,
            markerKey: undefined,
            leavesWhole: nativeChatSlotLeavesWhole(slot)
          })}
        />
      ))}
    </>
  )
}

/** Unwindowed rows with the gap the transcript column gives its rows; a continuing row's negative
 *  bottom margin is written against that gap, so rows outside the column must stack here. */
export function NativeChatTranscriptRowStack({
  slots,
  context
}: {
  slots: readonly NativeChatTranscriptSlot[]
  context: NativeChatTranscriptRowContext
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-5">
      <NativeChatWaitingTranscriptItems slots={slots} context={context} />
    </div>
  )
}

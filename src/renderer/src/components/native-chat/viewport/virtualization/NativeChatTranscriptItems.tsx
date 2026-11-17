import { Fragment, useMemo } from 'react'
import {
  NativeChatTranscriptRow,
  type NativeChatTranscriptRowContext
} from '../../messages/rows/NativeChatTranscriptRow'
import { nativeChatSlotKey } from '../../conversation/slots/native-chat-transcript-slot-selection'
import type { NativeChatTranscriptSlot } from '../../conversation/slots/native-chat-transcript-slots'
import {
  useNativeChatTimedRows,
  type NativeChatTimedRow
} from '../../conversation/slots/native-chat-timed-rows'
import type { NativeChatTranscriptWindow } from './use-native-chat-transcript-window'
import type { ReaderGesture } from '../scroll/native-chat-autoscroll'
import { NativeChatForwardedGestureContext } from '../scroll/native-chat-reader-scroll-input'
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
  newRowsMarker,
  forwardGesture
}: {
  slots: readonly NativeChatTranscriptSlot[]
  /** Rows from outside the conversation, each drawn after the message it followed in time. */
  timedRows?: readonly NativeChatTimedRow[]
  loadedMessageIds: ReadonlySet<string>
  context: NativeChatTranscriptRowContext
  window: NativeChatTranscriptWindow
  newRowsMarker?: NativeChatNewRowsMarkerState
  /** A reader gesture a row's visual frame took before the transcript could see it. */
  forwardGesture: (gesture: ReaderGesture) => void
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
      <NativeChatForwardedGestureContext.Provider value={forwardGesture}>
        <div ref={window.sizerRef} data-native-chat-window className="relative w-full">
          {window.virtualItems.map((item, position) => {
            const slot = slots[item.index]
            if (!slot) {
              return null
            }
            const previousEnd = window.virtualItems[position - 1]?.end ?? window.scrollMargin
            return (
              <Fragment key={item.key}>
                <div aria-hidden style={{ height: Math.max(0, item.start - previousEnd) }} />
                <div data-index={item.index} ref={window.measureRow} className="flow-root w-full">
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
      </NativeChatForwardedGestureContext.Provider>
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
      {slots.map((slot) => (
        <NativeChatTranscriptRow key={nativeChatSlotKey(slot)} slot={slot} context={context} />
      ))}
    </>
  )
}

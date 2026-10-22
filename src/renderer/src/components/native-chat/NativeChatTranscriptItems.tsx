import { Fragment, useMemo } from 'react'
import {
  NativeChatTranscriptRow,
  type NativeChatTranscriptRowContext
} from './NativeChatTranscriptRow'
import { nativeChatSlotKey, type NativeChatTranscriptSlot } from './native-chat-transcript-slots'
import type { NativeChatTranscriptWindow } from './use-native-chat-transcript-window'
import type { ReaderGesture } from './native-chat-autoscroll'
import { NativeChatForwardedGestureContext } from './native-chat-reader-scroll-input'
import type { NativeChatNewRowsMarkerState } from './native-chat-new-rows-marker'
import {
  NativeChatReplyRevealsContext,
  useNativeChatReplyReveals
} from './native-chat-reply-reveals'

/** Mounted rows own their height; only unloaded gaps use cached measurements. */
export function NativeChatTranscriptItems({
  slots,
  loadedMessageIds,
  context,
  window,
  newRowsMarker,
  forwardGesture
}: {
  slots: readonly NativeChatTranscriptSlot[]
  loadedMessageIds: ReadonlySet<string>
  context: NativeChatTranscriptRowContext
  window: NativeChatTranscriptWindow
  newRowsMarker?: NativeChatNewRowsMarkerState
  /** A reader gesture a row's visual frame took before the transcript could see it. */
  forwardGesture: (gesture: ReaderGesture) => void
}): React.JSX.Element {
  const rowKeys = useMemo(() => slots.map(nativeChatSlotKey), [slots])
  const replyReveals = useNativeChatReplyReveals(rowKeys, loadedMessageIds)
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
                    context={context}
                    newRowsMarker={
                      rowKeys[item.index] === newRowsMarker?.key ? newRowsMarker : undefined
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

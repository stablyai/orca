import { Fragment, useMemo } from 'react'
import {
  NativeChatTranscriptRow,
  type NativeChatTranscriptRowContext
} from './NativeChatTranscriptRow'
import { nativeChatSlotKey, type NativeChatTranscriptSlot } from './native-chat-transcript-slots'
import type { NativeChatTranscriptWindow } from './use-native-chat-transcript-window'
import {
  NativeChatReplyRevealsContext,
  useNativeChatReplyReveals
} from './native-chat-reply-reveals'

/** Mounted rows own their height; only unloaded gaps use cached measurements. */
export function NativeChatTranscriptItems({
  slots,
  context,
  window
}: {
  slots: readonly NativeChatTranscriptSlot[]
  context: NativeChatTranscriptRowContext
  window: NativeChatTranscriptWindow
}): React.JSX.Element {
  const rowKeys = useMemo(() => slots.map(nativeChatSlotKey), [slots])
  const replyReveals = useNativeChatReplyReveals(rowKeys)
  return (
    <NativeChatReplyRevealsContext.Provider value={replyReveals}>
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
                <NativeChatTranscriptRow slot={slot} context={context} />
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

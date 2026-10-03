import {
  NativeChatTranscriptRow,
  type NativeChatTranscriptRowContext
} from './NativeChatTranscriptRow'
import { nativeChatSlotKey, type NativeChatTranscriptSlot } from './native-chat-transcript-slots'
import type { NativeChatTranscriptWindow } from './use-native-chat-transcript-window'

/** Windowed transcript rows, absolutely positioned inside a full-height spacer. */
export function NativeChatTranscriptItems({
  slots,
  context,
  window
}: {
  slots: readonly NativeChatTranscriptSlot[]
  context: NativeChatTranscriptRowContext
  window: NativeChatTranscriptWindow
}): React.JSX.Element {
  return (
    <div
      ref={window.sizerRef}
      data-native-chat-window
      className="relative w-full"
      style={{ height: `${window.totalSize}px` }}
    >
      {window.virtualItems.map((item) => {
        const slot = slots[item.index]
        if (!slot) {
          return null
        }
        return (
          <div
            key={item.key}
            data-index={item.index}
            ref={window.measureRow}
            // `top`, not a transform: the reveal path walks `offsetTop` to find
            // where a card sits, and a transform is invisible to it.
            style={{
              position: 'absolute',
              top: `${item.start - window.scrollMargin}px`,
              left: 0,
              width: '100%'
            }}
          >
            <NativeChatTranscriptRow slot={slot} context={context} />
          </div>
        )
      })}
    </div>
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

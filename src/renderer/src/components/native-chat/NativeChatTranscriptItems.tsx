import {
  NativeChatTranscriptRow,
  type NativeChatTranscriptRowContext
} from './NativeChatTranscriptRow'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'
import type { NativeChatTranscriptWindow } from './use-native-chat-transcript-window'

/** The transcript's rows, either windowed or whole.
 *
 *  Windowed, they sit at absolute offsets inside a spacer the height of the
 *  entire transcript; whole, they are plain children of the transcript column and
 *  lay out exactly as they did before windowing existed. The control path is not
 *  a degraded mode — it is what runs whenever the scroll root cannot say where
 *  the viewport is, and it has to stay indistinguishable from the old list. */
export function NativeChatTranscriptItems({
  slots,
  context,
  window
}: {
  slots: readonly NativeChatTranscriptSlot[]
  context: NativeChatTranscriptRowContext
  window: NativeChatTranscriptWindow
}): React.JSX.Element {
  if (!window.isWindowed) {
    return (
      <>
        {slots.map((slot) => (
          <NativeChatTranscriptRow key={slot.message.id} slot={slot} context={context} />
        ))}
      </>
    )
  }
  return (
    <div
      ref={window.sizerRef}
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

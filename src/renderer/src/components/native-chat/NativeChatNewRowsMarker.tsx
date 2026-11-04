import { useEffect, useLayoutEffect, useRef } from 'react'
import { translate } from '@/i18n/i18n'
import { NATIVE_CHAT_BOTTOM_THRESHOLD_PX } from './native-chat-autoscroll'
import type { NativeChatNewRowsMarkerState } from './native-chat-new-rows-marker'
import { nativeChatScrollOffsetWithin } from './use-native-chat-viewport-align'

/** Fields in the pane that take text for something other than the conversation. */
const NOT_THE_CONVERSATION = '[data-native-chat-typing-redirect-ignore="true"]'

export function NativeChatNewRowsMarker({
  marker: { arriving, onArrived, onDismiss },
  onReveal
}: {
  marker: NativeChatNewRowsMarkerState
  /** Scrolls a transcript element to the top of the view, and stops following the end. */
  onReveal: (element: HTMLElement) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const label = translate('components.native-chat.newRowsMarker', 'New')

  useLayoutEffect(() => {
    if (!arriving) {
      return
    }
    onArrived()
    const marker = ref.current
    const row = marker?.closest<HTMLElement>('[data-index]')
    const scroller = row?.closest<HTMLElement>('[data-native-chat-scroll]')
    if (!marker || !row || !scroller) {
      return
    }
    const top = nativeChatScrollOffsetWithin(marker, scroller)
    // Preserve a reader parked above new rows; replies can still be short while paced rendering catches up.
    if (
      top === null ||
      top - (scroller.scrollTop + scroller.clientHeight) > NATIVE_CHAT_BOTTOM_THRESHOLD_PX
    ) {
      return
    }
    // Reveal the prompt’s row unless it would leave the marker too low in the viewport.
    const intoRow = top - (nativeChatScrollOffsetWithin(row, scroller) ?? top)
    onReveal(intoRow < scroller.clientHeight / 2 ? row : marker)
  }, [arriving, onArrived, onReveal])

  useEffect(() => {
    const pane = ref.current?.closest('[data-native-chat-root]')
    // Only conversation input dismisses the marker; Find and other unrelated fields do not.
    const onInput = (event: Event): void => {
      if (!(event.target instanceof Element && event.target.closest(NOT_THE_CONVERSATION))) {
        onDismiss()
      }
    }
    pane?.addEventListener('beforeinput', onInput)
    return () => pane?.removeEventListener('beforeinput', onInput)
  }, [onDismiss])

  return (
    <div
      ref={ref}
      role="separator"
      aria-label={label}
      className="flex items-center gap-3 text-2xs font-semibold uppercase tracking-[0.05em] text-chat-unread transition-opacity duration-300 ease-out starting:opacity-0 motion-reduce:transition-none"
    >
      <span>{label}</span>
      <span aria-hidden className="h-px flex-1 bg-chat-unread/50" />
    </div>
  )
}

/** Keep the live region mounted before inserting text so screen readers announce it. */
export function NativeChatNewRowsAnnouncement({ marked }: { marked: boolean }): React.JSX.Element {
  return (
    <div aria-live="polite" className="sr-only">
      {marked
        ? translate(
            'components.native-chat.newRowsAnnouncement',
            'New messages arrived while you were away'
          )
        : null}
    </div>
  )
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { NATIVE_CHAT_BOTTOM_THRESHOLD_PX } from '../scroll/native-chat-autoscroll'
import type { NativeChatNewRowsMarkerState } from './native-chat-new-rows-marker'
import { nativeChatScrollOffsetWithin } from '../virtualization/use-native-chat-viewport-align'

/** Fields in the pane that take text for something other than the conversation. */
const NOT_THE_CONVERSATION = '[data-native-chat-typing-redirect-ignore="true"]'

/** A line is drawn for missed rows taller than this many views, when nothing else calls for one. */
export const NEW_ROWS_MARKER_MIN_VIEWPORTS = 1
/** How long a line stays once it is fully in view of a reader who is looking. */
export const NEW_ROWS_MARKER_LINGER_MS = 3000
export const NEW_ROWS_MARKER_FADE_MS = 480

/**
 * How far the transcript reaches below the marker, against the height of the view; null without
 * layout. The window's spacers stand in for unmounted rows at the virtualizer's measured or
 * estimated sizes. Rows drawn after the window (held sends, the live activity line) are not counted.
 */
function missedHeight(marker: HTMLElement): { missedPx: number; viewportPx: number } | null {
  const rows = marker.closest<HTMLElement>('[data-native-chat-window]')
  const scroller = rows?.closest<HTMLElement>('[data-native-chat-scroll]')
  if (!rows || !scroller || scroller.clientHeight === 0) {
    return null
  }
  const top = nativeChatScrollOffsetWithin(marker, scroller)
  const rowsTop = nativeChatScrollOffsetWithin(rows, scroller)
  return top === null || rowsTop === null
    ? null
    : { missedPx: rowsTop + rows.offsetHeight - top, viewportPx: scroller.clientHeight }
}

/** Fully in view, allowing for the rounding fractional zoom brings to intersection ratios. */
const WHOLE_RATIO = 0.99

/** Whether the marker shows whole in the transcript's view. */
function useFullyInView(ref: React.RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!enabled || !element || typeof IntersectionObserver === 'undefined') {
      setInView(false)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry !== undefined && entry.intersectionRatio >= WHOLE_RATIO),
      { root: element.closest('[data-native-chat-scroll]'), threshold: WHOLE_RATIO }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, enabled])
  return inView
}

export function NativeChatNewRowsMarker({
  marker: { look, arriving, watching, onArrived, onDismiss, onMeasured, onFaded },
  onReveal
}: {
  marker: NativeChatNewRowsMarkerState
  /** Scrolls a transcript element to the top of the view, and stops following the end. */
  onReveal: (element: HTMLElement) => void
}): React.JSX.Element {
  const t = useTranslate()
  const ref = useRef<HTMLDivElement>(null)
  const label = t('components.native-chat.newRowsMarker', 'New')

  // Measured once, in layout before paint: the re-render shows the line or draws nothing.
  useLayoutEffect(() => {
    if (look !== 'measure' || !ref.current) {
      return
    }
    const height = missedHeight(ref.current)
    // Without layout, draw: a missing line costs more than one that fades on its own.
    onMeasured(
      height === null || height.missedPx > NEW_ROWS_MARKER_MIN_VIEWPORTS * height.viewportPx
    )
  }, [look, onMeasured])

  useLayoutEffect(() => {
    if (!arriving || look !== 'line') {
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
  }, [arriving, look, onArrived, onReveal])

  // The clock starts over whenever the reader stops seeing the line before it runs out.
  const inView = useFullyInView(ref, look === 'line')
  const seeing = look === 'line' && inView && watching
  useEffect(() => {
    if (!seeing) {
      return
    }
    // Faded from here on, so a look away mid-fade already counts it as seen; the fade itself is CSS.
    const timer = setTimeout(onFaded, NEW_ROWS_MARKER_LINGER_MS)
    return () => clearTimeout(timer)
  }, [seeing, onFaded])

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

  // Faded, it keeps its place and size so nothing below moves, but is no longer read as a separator.
  const shown = look === 'line'
  return (
    <div
      // Drawn after measuring as a new element, so it fades in like a line drawn straight away.
      key={look === 'measure' ? 'measure' : 'drawn'}
      ref={ref}
      role={shown ? 'separator' : undefined}
      aria-label={shown ? label : undefined}
      aria-hidden={shown ? undefined : true}
      // Reduced motion drops the transition, so it goes at once.
      style={look === 'faded' ? { transitionDuration: `${NEW_ROWS_MARKER_FADE_MS}ms` } : undefined}
      className={cn(
        'flex items-center gap-3 text-2xs font-semibold uppercase tracking-[0.05em] text-chat-unread transition-opacity duration-300 ease-out starting:opacity-0 motion-reduce:transition-none',
        look === 'measure' && 'invisible',
        look === 'faded' && 'opacity-0'
      )}
    >
      <span>{label}</span>
      <span aria-hidden className="h-px flex-1 bg-chat-unread/50" />
    </div>
  )
}

/** Keep the live region mounted before inserting text so screen readers announce it. */
export function NativeChatNewRowsAnnouncement({
  arrival
}: {
  /** Counts the returns that found rows missed; a new count is announced again. */
  arrival: number | undefined
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div aria-live="polite" className="sr-only">
      {arrival === undefined ? null : (
        <span key={arrival}>
          {t(
            'components.native-chat.newRowsAnnouncement',
            'New messages arrived while you were away'
          )}
        </span>
      )}
    </div>
  )
}

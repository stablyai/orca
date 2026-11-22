import { useContext, useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useNativeChatDisclosure } from '../disclosure/native-chat-disclosure-store'
import { NativeChatToolRunWindowContext } from '../../tools/runs/native-chat-tool-run-window-context'
import {
  NativeChatEventDetails,
  NativeChatEventIcon,
  type NativeChatEventBadge
} from '../events/NativeChatEventRow'
import {
  NativeChatMessageTimestamp,
  useNativeChatMessageTimeLabel
} from './NativeChatMessageTimestamp'

/** Takes no width until the row is hovered or holds keyboard focus, so it never cuts the first line
 *  short; kept on touch, where nothing hovers. It stays laid out at zero width, its gap pulled back,
 *  so a row can measure the room it will need. A narrow chat shows a row button's time in its open message instead. */
const TIME =
  'shrink-0 overflow-hidden can-hover:-ml-1.5 can-hover:w-0 can-hover:group-hover/agent-row:ml-0 can-hover:group-hover/agent-row:w-auto can-hover:group-has-[:focus-visible]/agent-row:ml-0 can-hover:group-has-[:focus-visible]/agent-row:w-auto @max-[360px]/agent-row:hidden!'

/** How much wider an element's text is than its box, to the fraction of a pixel: the text is laid out
 *  whole even where it is drawn cut or the box has no width. Whole-pixel scroll widths miss a line a
 *  fraction of a pixel too long, which already ends in an ellipsis. */
function textOverflow(element: HTMLElement): number {
  const range = document.createRange()
  range.selectNodeContents(element)
  const style = getComputedStyle(element)
  const box =
    element.getBoundingClientRect().width -
    (Number.parseFloat(style.paddingLeft) || 0) -
    (Number.parseFloat(style.paddingRight) || 0)
  return range.getBoundingClientRect().width - box
}

/** Whether the first line is cut now, or would be once the time shows on hover or focus: the line
 *  fits only if the row has room left for the time's hidden width. */
function previewCutShort(
  preview: HTMLElement,
  row: HTMLElement,
  time: HTMLElement | null
): boolean {
  if (textOverflow(preview) > 0.01) {
    return true
  }
  // A hidden time also pulls its gap back with a negative margin; both come back when it shows.
  const timeCut = time ? textOverflow(time) : 0
  const hiddenTime =
    time && timeCut > 0.01
      ? timeCut - (Number.parseFloat(getComputedStyle(time).marginLeft) || 0)
      : 0
  const container = row.parentElement
  // The row may reach past its container by its own 0.25rem bleed on each side.
  const free = container
    ? container.getBoundingClientRect().width + 8 - row.getBoundingClientRect().width
    : 0
  return hiddenTime > free + 0.01
}

/**
 * A message between agents as one line: its sender's mark, a kind word for a start or a task, the
 * sender's name, the message's first line and, when there is more to read, a chevron that opens it.
 * The whole line is the button; it names itself in full words ("Task from Parser: …") for screen
 * readers, while the drawn words stay short. A message whose one line shows whole is a plain line.
 */
export function NativeChatAgentMessageRow({
  icon,
  badge,
  kind,
  lead,
  names,
  spokenNames,
  preview,
  more,
  timestamp,
  details,
  disclosureKey,
  onOpenChange,
  className
}: {
  icon: React.ReactNode
  badge?: NativeChatEventBadge | null
  /** A one-word kind drawn before the name ("Task", "Started"); none for a plain message. */
  kind: string | null
  /** The full lead screen readers hear before the name, e.g. "Message from". */
  lead: string
  /** The drawn sender names; may hold buttons that open a sender. Read by screen readers as `names(spoken)`. */
  names: (spoken: boolean) => React.ReactNode
  spokenNames: string
  /** The message's first line as plain text; empty draws the name and chevron alone. */
  preview: string
  /** Whether the details hold more than `preview` shows. */
  more: boolean
  timestamp: number | null
  /** Null when there is nothing to open. */
  details: React.ReactNode | null
  disclosureKey: string
  onOpenChange?: (open: boolean) => void
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const disclosure = useNativeChatDisclosure(disclosureKey, false)
  const { findActive } = useContext(NativeChatToolRunWindowContext)
  const time = useNativeChatMessageTimeLabel(timestamp)
  const detailsId = useId()
  const rowRef = useRef<HTMLDivElement | null>(null)
  const previewRef = useRef<HTMLSpanElement | null>(null)
  const timeRef = useRef<HTMLSpanElement | null>(null)
  const [previewCut, setPreviewCut] = useState(false)
  const expandable = details !== null
  const open = disclosure.open
  // A line that shows the whole message opens nothing, unless the row is cut short or already open.
  const toggles = expandable && (more || preview === '' || previewCut || open)
  const shown = toggles && (open || findActive)
  const measures = expandable && !more && preview !== '' && !shown
  useLayoutEffect(() => {
    const node = previewRef.current
    const row = rowRef.current
    if (!measures || !node || !row) {
      return
    }
    const measure = () => setPreviewCut(previewCutShort(node, row, timeRef.current))
    measure()
    // A narrower chat cuts the line; a wider one can show it whole again.
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    if (row.parentElement) {
      observer.observe(row.parentElement)
    }
    return () => observer.disconnect()
  }, [measures, preview])
  const state =
    badge === 'running'
      ? t('components.native-chat.eventRow.running', 'Running')
      : badge === 'failed'
        ? t('components.native-chat.eventRow.failed', 'Failed')
        : null
  const spokenHead = `${lead} ${spokenNames}${state ? `, ${state}` : ''}`
  const previewShown = preview !== '' && !shown
  // Over the row button, drawn words let clicks through to it; only links and sender buttons take them.
  const content = cn(
    'relative',
    toggles && 'pointer-events-none [&_a]:pointer-events-auto [&_button]:pointer-events-auto'
  )
  return (
    <div className={cn('@container/agent-row', className)}>
      <div
        ref={rowRef}
        className={cn(
          'group/agent-row relative -mx-1 flex w-fit max-w-[calc(100%+0.5rem)] min-h-6 items-center gap-1.5 rounded-md px-1 font-sans text-sm leading-relaxed text-chat-foreground-faint',
          toggles && 'hover:bg-foreground/[0.04]',
          previewShown &&
            '@max-[360px]/agent-row:w-[calc(100%+0.5rem)] @max-[360px]/agent-row:flex-wrap @max-[360px]/agent-row:gap-y-0 @max-[360px]/agent-row:pb-1'
        )}
      >
        {toggles ? (
          <button
            type="button"
            aria-expanded={shown}
            aria-controls={shown ? detailsId : undefined}
            className="absolute inset-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              disclosure.setOpen(!open)
              onOpenChange?.(!open)
            }}
          >
            <span className="sr-only">
              {`${spokenHead}${preview ? `: ${preview}` : ''}${time ? `, ${time}` : ''}`}
            </span>
          </button>
        ) : null}
        <span className={cn(content, 'flex shrink-0')} aria-hidden={toggles || undefined}>
          <NativeChatEventIcon badge={badge}>{icon}</NativeChatEventIcon>
        </span>
        {toggles ? null : <span className="sr-only">{`${lead} `}</span>}
        {kind ? (
          <span aria-hidden className={cn(content, 'shrink-0 whitespace-nowrap')}>
            {kind}
          </span>
        ) : null}
        <span
          className={cn(
            content,
            // The first line gives way first, down to a few words or to the room a name and an item
            // need to keep a few letters each. It never shrinks, since any shrink at all cuts its last
            // letters for an ellipsis; past its cap the name, then its items, cut short.
            'flex min-w-0 max-w-[max(100cqw-16rem,12rem)] shrink-0 items-center gap-1 font-medium whitespace-nowrap text-chat-foreground',
            '@max-[360px]/agent-row:max-w-fit @max-[360px]/agent-row:shrink @max-[360px]/agent-row:grow @max-[360px]/agent-row:basis-0'
          )}
        >
          {names(!toggles)}
        </span>
        {toggles ? null : (
          <span className="sr-only">{`${state ? `, ${state}` : ''}${preview ? ': ' : ''}`}</span>
        )}
        {previewShown ? (
          <span
            ref={previewRef}
            aria-hidden={toggles || undefined}
            className={cn(
              content,
              'min-w-0 max-w-[48ch] truncate',
              '@max-[360px]/agent-row:order-last @max-[360px]/agent-row:max-w-none @max-[360px]/agent-row:basis-full @max-[360px]/agent-row:pl-5'
            )}
          >
            {preview}
          </span>
        ) : null}
        {!toggles && time ? <span className="sr-only">{`, ${time}`}</span> : null}
        {expandable ? (
          // Kept in place, unseen, on a line that shows whole, so whether the line fits never
          // depends on whether the chevron was drawn when it was measured.
          <ChevronRight
            aria-hidden
            className={cn(
              'relative pointer-events-none size-3.5 shrink-0 transition-transform dark:opacity-70',
              !toggles && 'invisible',
              shown && 'rotate-90'
            )}
          />
        ) : null}
        {timestamp !== null ? (
          <span ref={timeRef} aria-hidden className={cn(content, TIME)}>
            <NativeChatMessageTimestamp timestamp={timestamp} />
          </span>
        ) : null}
      </div>
      {shown ? (
        <NativeChatEventDetails id={detailsId} clamp findActive={findActive} rows={false}>
          {timestamp !== null ? (
            <span className="hidden @max-[360px]/agent-row:block">
              <NativeChatMessageTimestamp timestamp={timestamp} />
            </span>
          ) : null}
          {details}
        </NativeChatEventDetails>
      ) : null}
    </div>
  )
}

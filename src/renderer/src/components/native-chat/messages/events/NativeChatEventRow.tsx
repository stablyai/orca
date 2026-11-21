import { Children, useContext, useId, useLayoutEffect, useRef, useState, type Ref } from 'react'
import { ChevronRight, X } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { AgentWorkingSpinner } from '@/components/agent/status/AgentWorkingSpinner'
import {
  NativeChatMessageTimestamp,
  useNativeChatMessageTimeLabel
} from '../rows/NativeChatMessageTimestamp'
import { useNativeChatDisclosure } from '../disclosure/native-chat-disclosure-store'
import { NativeChatToolRunWindowContext } from '../../tools/runs/native-chat-tool-run-window-context'

/** Hidden until the row is hovered or holds keyboard focus; kept on touch, where nothing hovers.
 *  Same reveal as a message's time and copy, so nothing shifts when it shows. */
const REVEAL_OPACITY =
  'transition-opacity can-hover:opacity-0 group-hover/event-row:opacity-100 group-has-[:focus-visible]/event-row:opacity-100'
const REVEAL_POINTER =
  'can-hover:pointer-events-none group-hover/event-row:pointer-events-auto group-has-[:focus-visible]/event-row:pointer-events-auto'
export const NATIVE_CHAT_EVENT_ROW_REVEAL = `${REVEAL_OPACITY} ${REVEAL_POINTER}`

export type NativeChatEventBadge = 'running' | 'failed'

/** The row's 14px mark with its state in a badge at the bottom right: a spinner while it runs, a red ✕ when it failed. */
function NativeChatEventIcon({
  children,
  badge
}: {
  children: React.ReactNode
  badge?: NativeChatEventBadge | null
}): React.JSX.Element {
  return (
    <span className="relative flex size-3.5 items-center justify-center">
      {children}
      {badge ? (
        <span className="absolute -right-1 -bottom-1 flex size-2.5 items-center justify-center rounded-full bg-chat-pane">
          {badge === 'running' ? (
            <AgentWorkingSpinner className="size-[7px] border-[1.5px]" />
          ) : (
            <span className="flex size-2 items-center justify-center rounded-full bg-destructive text-chat-pane">
              <X className="size-1.5" strokeWidth={4} aria-hidden />
            </span>
          )}
        </span>
      ) : null}
    </span>
  )
}

/** Details cut at about four lines, with Show more, in the quiet fill comments use. */
function EventDetails({
  id,
  clamp,
  findActive,
  rows,
  children
}: {
  id: string
  clamp: boolean
  /** Find reads drawn text, so a search shows the details whole. */
  findActive: boolean
  /** Details that are rows themselves: indented without the fill, whose color would show behind their controls. */
  rows: boolean
  children: React.ReactNode
}) {
  const t = useTranslate()
  const body = useRef<HTMLDivElement | null>(null)
  const [cut, setCut] = useState(false)
  const [chosenFull, setFull] = useState(!clamp)
  const full = chosenFull || findActive
  useLayoutEffect(() => {
    const node = body.current
    if (!node || full || rows) {
      return
    }
    const measure = () => setCut(node.scrollHeight > node.clientHeight + 1)
    measure()
    // A narrower transcript or an image that loads later can push the words past the cut.
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    for (const child of node.children) {
      observer.observe(child)
    }
    return () => observer.disconnect()
  }, [children, full, rows])
  if (rows) {
    return (
      <div id={id} className="mt-1 ml-5">
        {children}
      </div>
    )
  }
  return (
    <div
      id={id}
      className="mt-0.5 mb-1 ml-5 rounded-[10px] bg-foreground/[0.035] px-2 pt-1.5 pb-2 dark:bg-foreground/[0.045]"
    >
      <div
        ref={body}
        className={cn(
          'flex flex-col gap-1.5 text-sm leading-5 text-chat-foreground [overflow-wrap:anywhere]',
          !full && 'max-h-[86px] overflow-hidden',
          !full && cut && '[mask-image:linear-gradient(to_bottom,#000_calc(100%-44px),transparent)]'
        )}
      >
        {children}
      </div>
      {clamp && !findActive && (cut || full) ? (
        <button
          type="button"
          aria-expanded={full}
          className="mt-1.5 rounded-sm text-xs font-medium text-chat-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setFull(!full)}
        >
          {full
            ? t('components.native-chat.eventRow.showLess', 'Show less')
            : t('components.native-chat.eventRow.showMore', 'Show more')}
        </button>
      ) : null}
    </div>
  )
}

/** The row's words as pieces of its one line: a bare text run becomes its own piece, which cuts
 *  short with an ellipsis and shows whole on hover (a flex row can't shrink bare text). */
function rowParts(children: React.ReactNode): React.ReactNode[] {
  const seen = new Map<string, number>()
  return Children.toArray(children).flatMap((child): React.ReactNode[] => {
    if (typeof child !== 'string' && typeof child !== 'number') {
      return [child]
    }
    const text = String(child).trim()
    if (!text) {
      return []
    }
    // Keyed by its words, so a row whose parts change keeps each text piece its own.
    const repeat = seen.get(text) ?? 0
    seen.set(text, repeat + 1)
    return [
      <span key={`text:${text}:${repeat}`} className="min-w-0 truncate" title={text}>
        {text}
      </span>
    ]
  })
}

/**
 * One status line in the transcript: icon · text, then on hover or keyboard focus its action, a chevron
 * and the time. With details the whole row is the button that opens them; links, chips and the action
 * sit above that button, never inside it. Its open state lives in the transcript's disclosure store
 * under `disclosureKey`, so scrolling it out of the window and back keeps it.
 */
export function NativeChatEventRow({
  icon,
  badge,
  children,
  label,
  action,
  timestamp,
  details,
  disclosureKey,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  buttonRef,
  clampDetails = true,
  detailsAreRows = false,
  className
}: {
  icon: React.ReactNode
  /** Its state on the mark; screen readers hear it with the row's words. */
  badge?: NativeChatEventBadge | null
  /** The row's words; may hold links and chips. */
  children: React.ReactNode
  /** The words as plain text: the row button's name, with the time. */
  label?: string
  /** Shown right after the words on hover or focus, e.g. an open button. */
  action?: React.ReactNode
  timestamp?: number | null
  details?: React.ReactNode
  /** Where the transcript remembers whether this row's details are open. */
  disclosureKey?: string
  defaultOpen?: boolean
  /** Given by a row that keeps its open state itself; it changes through `onOpenChange`. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  buttonRef?: Ref<HTMLButtonElement>
  /** Reports cut at about four lines; a short list of links shows whole. */
  clampDetails?: boolean
  detailsAreRows?: boolean
  className?: string
}): React.JSX.Element {
  const disclosure = useNativeChatDisclosure(disclosureKey, defaultOpen)
  const { findActive } = useContext(NativeChatToolRunWindowContext)
  const t = useTranslate()
  const time = useNativeChatMessageTimeLabel(timestamp)
  const state =
    badge === 'running'
      ? t('components.native-chat.eventRow.running', 'Running')
      : badge === 'failed'
        ? t('components.native-chat.eventRow.failed', 'Failed')
        : null
  const detailsId = useId()
  const toggles = details !== undefined && details !== null && details !== false
  const open = openProp ?? disclosure.open
  const hasTime = timestamp !== undefined && timestamp !== null
  // Find searches drawn text: while it has a query, folded details are drawn so it can reach them.
  const shown = open || findActive
  return (
    <div className={className}>
      <div className="group/event-row @container/event-row relative flex min-h-6 items-start gap-1.5 font-sans text-sm leading-relaxed text-chat-foreground-faint">
        {toggles ? (
          <button
            type="button"
            ref={buttonRef}
            aria-expanded={shown}
            aria-controls={shown ? detailsId : undefined}
            aria-label={[label, state, time].filter(Boolean).join(', ') || undefined}
            // The words take no pointer, so a name cut short shows whole here.
            title={label}
            className="absolute -inset-x-1 -inset-y-0.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              if (openProp === undefined) {
                disclosure.setOpen(!open)
              }
              onOpenChange?.(!open)
            }}
          />
        ) : null}
        <span
          className={cn(
            'relative mt-[5px] flex shrink-0',
            toggles &&
              'pointer-events-none [&_a]:pointer-events-auto [&_button]:pointer-events-auto'
          )}
        >
          <NativeChatEventIcon badge={badge}>{icon}</NativeChatEventIcon>
        </span>
        {/* Always one line: its parts sit side by side and the ones that can shrink (chips, names)
            cut short with an ellipsis; clipping only sideways keeps chip focus rings whole. */}
        <span
          className={cn(
            'relative flex min-w-0 items-center gap-x-1 overflow-x-clip whitespace-nowrap [&>*]:min-w-0 [&>*]:overflow-x-clip [&>*]:text-ellipsis',
            toggles &&
              'pointer-events-none [&_a]:pointer-events-auto [&_button]:pointer-events-auto'
          )}
        >
          {/* A row with no button says its state in its own text. */}
          {state && !toggles ? <span className="sr-only">{state}, </span> : null}
          {rowParts(children)}
        </span>
        {/* With a pointer the controls lie over the row's end and take no width until shown; touch keeps them in line.
            Over a row button, clicks on the chevron and time fall through to it; only the action takes them. */}
        {action || toggles || hasTime ? (
          <span
            className={cn(
              'relative ml-auto flex h-6 shrink-0 items-center gap-1.5 pl-2',
              "can-hover:absolute can-hover:top-0 can-hover:right-0 can-hover:bg-chat-pane can-hover:before:pointer-events-none can-hover:before:absolute can-hover:before:inset-y-0 can-hover:before:right-full can-hover:before:w-4 can-hover:before:bg-linear-to-r can-hover:before:from-transparent can-hover:before:to-chat-pane can-hover:before:content-['']",
              toggles
                ? cn('pointer-events-none', !shown && REVEAL_OPACITY)
                : !shown && NATIVE_CHAT_EVENT_ROW_REVEAL
            )}
          >
            {action ? (
              <span
                className={cn(
                  'flex',
                  toggles && 'pointer-events-auto',
                  toggles && !shown && REVEAL_POINTER
                )}
              >
                {action}
              </span>
            ) : null}
            {toggles ? (
              <ChevronRight
                aria-hidden
                className={cn(
                  'pointer-events-none size-3.5 shrink-0 transition-transform',
                  shown && 'rotate-90'
                )}
              />
            ) : null}
            {hasTime ? (
              // A narrow pane drops the time; the row button still names it.
              <span className="hidden @sm/event-row:block">
                <NativeChatMessageTimestamp timestamp={timestamp} />
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      {toggles && shown ? (
        <EventDetails
          id={detailsId}
          clamp={clampDetails}
          findActive={findActive}
          rows={detailsAreRows}
        >
          {details}
        </EventDetails>
      ) : null}
    </div>
  )
}

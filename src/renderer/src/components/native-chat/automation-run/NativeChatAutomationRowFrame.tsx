import { useId, type ReactNode, type Ref } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/class-names'
import type { AutomationRowMark } from '../../../../../shared/automations/automation-chat-row'
import { NativeChatMessageTimestamp } from '../messages/rows/NativeChatMessageTimestamp'
import { NativeChatExpandable } from '../messages/disclosure/NativeChatExpandable'
import { NativeChatSubagentStatusIcon } from '../subagents/NativeChatSubagentStatusIcon'
import { NativeChatAutomationMark } from './NativeChatAutomationMark'

/** An opened row's section heading, and its muted lines. */
export const ROW_HEADING = 'mt-2.5 mb-0.5 text-xs font-normal text-muted-foreground first:mt-0.5'
export const ROW_NOTE = 'text-xs text-muted-foreground'

/** Every automation row in a chat, on the coordinator row's frame: mark, label, name, status, time,
 *  chevron; details only when opened. */
export function NativeChatAutomationRowFrame({
  mark,
  label,
  name,
  status,
  failed = false,
  accessibleName,
  timestamp,
  open,
  onToggle,
  action,
  runId,
  toggleRef,
  children
}: {
  mark: AutomationRowMark
  label: string
  name: string
  status: string
  /** A red dot before the status: it couldn't start or finish. */
  failed?: boolean
  accessibleName: string
  timestamp: number | null
  open: boolean
  onToggle: () => void
  /** Revealed beside the status, such as Copy instructions. */
  action?: ReactNode
  runId?: string
  toggleRef?: Ref<HTMLButtonElement>
  /** The opened body; given the ids that tie it to its toggle. */
  children: (ids: { bodyId: string; toggleId: string }) => ReactNode
}): React.JSX.Element {
  const toggleId = useId()
  const bodyId = useId()
  return (
    <div
      className="group @container w-full rounded-xl border border-border bg-card text-sm text-card-foreground"
      data-native-chat-automation-run={runId}
    >
      <div className="relative flex min-w-0 items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          ref={toggleRef}
          id={toggleId}
          aria-label={accessibleName}
          aria-controls={bodyId}
          aria-expanded={open}
          onClick={onToggle}
          className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
        <div className="pointer-events-none" aria-hidden>
          <NativeChatAutomationMark mark={mark} />
        </div>
        <span
          aria-hidden
          className="pointer-events-none max-w-1/3 shrink-0 truncate text-xs text-muted-foreground"
        >
          {label}
        </span>
        {/* The name gives way first, down to a few letters; the status keeps its own slot. */}
        <span
          aria-hidden
          className="pointer-events-none min-w-[6ch] flex-1 basis-0 truncate text-foreground"
        >
          {name}
        </span>
        {status ? (
          <span
            aria-hidden
            className="pointer-events-none flex min-w-0 max-w-1/2 shrink items-center gap-1.5 text-xs text-muted-foreground"
          >
            {failed ? <NativeChatSubagentStatusIcon state="failed" /> : null}
            <span className="truncate">{status}</span>
          </span>
        ) : null}
        {action}
        <div className="pointer-events-none hidden shrink-0 @sm:block" aria-hidden>
          <NativeChatMessageTimestamp timestamp={timestamp} className="text-muted-foreground" />
        </div>
        <ChevronDown
          aria-hidden
          className={cn(
            'pointer-events-none size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
            open && 'rotate-180'
          )}
        />
      </div>
      <NativeChatExpandable open={open}>{children({ bodyId, toggleId })}</NativeChatExpandable>
    </div>
  )
}

/** An opened row's body region, under its toggle. */
export function NativeChatAutomationRowBody({
  ids,
  timestamp,
  children
}: {
  ids: { bodyId: string; toggleId: string }
  timestamp: number | null
  children: ReactNode
}): React.JSX.Element {
  return (
    <section
      id={ids.bodyId}
      role="region"
      aria-labelledby={ids.toggleId}
      className="px-3 pb-3 text-sm"
    >
      {children}
      <div className="mt-1.5 @sm:hidden">
        <NativeChatMessageTimestamp timestamp={timestamp} className="text-muted-foreground" />
      </div>
    </section>
  )
}

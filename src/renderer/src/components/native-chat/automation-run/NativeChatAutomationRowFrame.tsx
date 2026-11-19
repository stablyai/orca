import type { ReactNode, Ref } from 'react'
import type { AutomationRowMark } from '../../../../../shared/automations/automation-chat-row'
import { NativeChatEventRow } from '../messages/events/NativeChatEventRow'
import { NativeChatAutomationMark } from './NativeChatAutomationMark'

/** An opened row's section heading, and its muted lines. */
export const ROW_HEADING = 'mt-2.5 mb-0.5 text-xs font-normal text-muted-foreground first:mt-0'
export const ROW_NOTE = 'text-xs text-muted-foreground'

/** Every automation row in a chat, as a status row: its trigger's mark, "<lead> · <name> · <status>"
 *  (or "<lead> <name>" for a verb such as Couldn't start), then its details when opened. */
export function NativeChatAutomationRowFrame({
  mark,
  lead,
  name,
  status,
  leadIsVerb = false,
  failed = false,
  timestamp,
  open,
  onToggle,
  action,
  toggleRef,
  clampDetails,
  children
}: {
  mark: AutomationRowMark
  lead: string
  name: string
  status?: string | null
  leadIsVerb?: boolean
  /** A red ✕ on the mark: it couldn't start or finish. */
  failed?: boolean
  timestamp: number | null
  open: boolean
  onToggle: () => void
  /** Right after the words, such as Send again. */
  action?: ReactNode
  toggleRef?: Ref<HTMLButtonElement>
  clampDetails?: boolean
  children: ReactNode
}): React.JSX.Element {
  const after = status ? [status] : []
  const label = leadIsVerb
    ? [`${lead} ${name}`, ...after].join(' · ')
    : [lead, name, ...after].join(' · ')
  return (
    <NativeChatEventRow
      icon={<NativeChatAutomationMark mark={mark} />}
      badge={failed ? 'failed' : null}
      label={label}
      action={action}
      timestamp={timestamp}
      open={open}
      onOpenChange={onToggle}
      buttonRef={toggleRef}
      clampDetails={clampDetails}
      details={children}
    >
      {/* The status keeps its own line when the name needs the width, so neither is cut short. */}
      <span className="flex flex-wrap gap-x-1">
        <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">
          {lead}
          {leadIsVerb ? ' ' : ' · '}
          <span className="text-chat-foreground">{name}</span>
        </span>
        {status ? <span className="max-w-full truncate">· {status}</span> : null}
      </span>
    </NativeChatEventRow>
  )
}

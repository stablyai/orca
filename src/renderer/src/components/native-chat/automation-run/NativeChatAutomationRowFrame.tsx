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
      <span className="flex min-w-0 items-center">
        <span className="shrink-0 whitespace-pre">
          {lead}
          {leadIsVerb ? ' ' : ' · '}
        </span>
        <span className="min-w-0 truncate text-chat-foreground" title={name}>
          {name}
        </span>
        {status ? (
          <span className="min-w-0 max-w-max grow basis-0 truncate whitespace-pre">{` · ${status}`}</span>
        ) : null}
      </span>
    </NativeChatEventRow>
  )
}

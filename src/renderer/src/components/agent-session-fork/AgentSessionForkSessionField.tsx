import { useId, useState } from 'react'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import type { AgentSessionForkSource } from '@/lib/agent-session-fork-flow'
import { translate } from '@/i18n/i18n'
import { agentSessionForkOptionKey } from './agent-session-fork-options'

function OptionLabel({
  option,
  now
}: {
  option: AgentSessionForkSource
  now: number
}): React.JSX.Element {
  if (option.kind === 'none') {
    return <span>{translate('components.agentSessionFork.noAgent', 'No agent (branch only)')}</span>
  }
  if (option.kind === 'transcript') {
    return (
      <>
        <AgentIcon agent={option.agent} size={14} />
        <span className="truncate">
          {translate('components.agentSessionFork.transcriptOption', '{{agent}} (transcript)', {
            agent: getAgentLabel(option.agent)
          })}
        </span>
      </>
    )
  }
  const { session } = option
  return (
    <>
      <AgentIcon agent={session.agent} size={14} />
      <span className="truncate">{session.title ?? getAgentLabel(session.agent)}</span>
      <span className="text-muted-foreground">{formatShortTimeAgo(session.lastActiveAt, now)}</span>
    </>
  )
}

export function AgentSessionForkSessionField({
  options,
  value,
  onValueChange,
  disabled
}: {
  options: AgentSessionForkSource[]
  value: string
  onValueChange: (value: string) => void
  disabled: boolean
}): React.JSX.Element {
  const triggerId = useId()
  // Why: ages are read once per open; a ticking list would reorder labels under the pointer.
  const [now] = useState(() => Date.now())
  return (
    <div className="space-y-1">
      <Label htmlFor={triggerId}>
        {translate('components.agentSessionFork.session', 'Session')}
      </Label>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger id={triggerId} size="sm" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={agentSessionForkOptionKey(option)}
              value={agentSessionForkOptionKey(option)}
            >
              <OptionLabel option={option} now={now} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

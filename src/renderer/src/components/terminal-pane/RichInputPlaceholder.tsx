import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { AgentType } from '../../../../shared/agent-status-types'

export function richInputPlaceholder(agent: AgentType | null): string {
  return agent
    ? translate('components.terminal.richInput.agentPlaceholder', 'Ask anything…')
    : translate('components.terminal.richInput.terminalPlaceholder', 'Type a command or prompt…')
}

export function RichInputPlaceholder({
  agent,
  className
}: {
  agent: AgentType | null
  className?: string
}): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute left-2 top-1 text-sm text-muted-foreground/60',
        className
      )}
    >
      {richInputPlaceholder(agent)}
    </div>
  )
}

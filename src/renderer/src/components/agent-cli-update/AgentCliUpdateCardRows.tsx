import type { ReactNode } from 'react'
import { Copy } from 'lucide-react'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { agentCliProductName } from './agent-cli-product-name'
import { copyAgentCliUpdateCommand } from '../status-bar/updates/AgentCliUpdateList'
import type { AgentCliUpdateAgent } from '../../../../shared/agent-launch/installation/agent-cli-update'

const STACK_MAX = 4

/** Overlapping agent marks; past the max, the last slot counts the rest. */
export function AgentCliUpdateIconStack({
  agents
}: {
  agents: readonly AgentCliUpdateAgent[]
}): React.JSX.Element {
  const shown = agents.length > STACK_MAX ? agents.slice(0, STACK_MAX - 1) : agents
  const rest = agents.length - shown.length
  const chip =
    'flex size-6.5 shrink-0 items-center justify-center rounded-full bg-muted ring-2 ring-card not-first:-ml-1.5'
  return (
    <div className="mt-px flex shrink-0" aria-hidden>
      {shown.map((agent, index) => (
        <span key={`${agent}-${index}`} className={chip}>
          <AgentIcon agent={agent} size={14} />
        </span>
      ))}
      {rest > 0 ? (
        <span
          className={cn(chip, 'text-[10.5px] font-semibold text-muted-foreground tabular-nums')}
        >
          +{rest}
        </span>
      ) : null}
    </div>
  )
}

/** Opens to its content's height; closed content is inert so focus can't land in it. */
export function AgentCliUpdateCardReveal({
  open,
  children
}: {
  open: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
      )}
      inert={!open}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}

export function AgentCliUpdateCardRow({
  agent,
  children
}: {
  agent: AgentCliUpdateAgent
  /** The row's right side: versions, progress or result. */
  children: ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex h-8 items-center gap-2 pr-1.5 pl-2">
      <AgentIcon agent={agent} size={14} />
      <span className="truncate text-[13px]">{agentCliProductName(agent, t, 'short')}</span>
      <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
        {children}
      </span>
    </div>
  )
}

export function AgentCliUpdateCardVersions({
  from,
  to
}: {
  from: string
  to: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <span>
      {t('agentCliUpdate.versions', '{{installed}} → {{latest}}', {
        installed: from,
        latest: to
      })}
    </span>
  )
}

/** A CLI Orca can't update: its command, to run in a terminal. */
export function AgentCliUpdateCardManualRow({
  agent,
  from,
  to,
  command
}: {
  agent: AgentCliUpdateAgent
  from: string
  to: string
  command: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div>
      <AgentCliUpdateCardRow agent={agent}>
        <AgentCliUpdateCardVersions from={from} to={to} />
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => copyAgentCliUpdateCommand(command, t)}
        >
          <Copy />
          {t('agentCliUpdate.copyCommand', 'Copy')}
        </Button>
      </AgentCliUpdateCardRow>
      <p className="pr-2 pb-1.5 pl-7.5 text-2xs text-muted-foreground">
        {t('agentCliUpdate.manualHint', 'Run in a terminal:')}{' '}
        <code className="font-mono break-all text-foreground">{command}</code>
      </p>
    </div>
  )
}

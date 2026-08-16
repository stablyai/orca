import type React from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { AgentContextScope } from '../../../../shared/agent-context'
import type { AgentType } from '../../../../shared/agent-status-types'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { agentDisplayName } from './workspace-context-model'

export function scopeLabel(scope: AgentContextScope): string {
  switch (scope) {
    case 'project':
      return translate(
        'auto.components.rightSidebar.WorkspaceContextPanel.scopeProject',
        'Workspace'
      )
    case 'ancestor':
      return translate(
        'auto.components.rightSidebar.WorkspaceContextPanel.scopeAncestor',
        'Parent folder'
      )
    default:
      return translate('auto.components.rightSidebar.WorkspaceContextPanel.scopeHome', 'User')
  }
}

export function AgentChips({ agents }: { agents: readonly AgentType[] }): React.JSX.Element {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {agents.map((agent) => (
        <span
          key={agent}
          className="rounded-sm border border-border px-1 py-px text-[10px] leading-4 text-muted-foreground"
        >
          {agentDisplayName(agent)}
        </span>
      ))}
    </span>
  )
}

export function ContextSection({
  title,
  count,
  open,
  onToggle,
  children
}: {
  title: string
  count: number | null
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <section className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      >
        <Chevron className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {count !== null ? <span className="tabular-nums">{count}</span> : null}
      </button>
      {open ? <div className="pb-2">{children}</div> : null}
    </section>
  )
}

export function ContextRow({
  primary,
  secondary,
  meta,
  agents,
  muted = false,
  onClick,
  title
}: {
  primary: string
  secondary?: string
  meta?: string
  agents?: readonly AgentType[]
  muted?: boolean
  onClick?: () => void
  title?: string
}): React.JSX.Element {
  const body = (
    <>
      <div className="flex min-w-0 items-baseline gap-2">
        <span
          className={cn(
            'min-w-0 truncate text-xs',
            muted ? 'text-muted-foreground' : 'text-foreground'
          )}
        >
          {primary}
        </span>
        {meta ? (
          <span className="ml-auto min-w-0 max-w-[50%] shrink-0 truncate text-[10px] tabular-nums text-muted-foreground">
            {meta}
          </span>
        ) : null}
      </div>
      {secondary ? (
        <div className="truncate font-mono text-[10px] leading-4 text-muted-foreground" dir="rtl">
          <bdi>{secondary}</bdi>
        </div>
      ) : null}
      {agents && agents.length > 0 ? (
        <div className="mt-0.5">
          <AgentChips agents={agents} />
        </div>
      ) : null}
    </>
  )
  const className = cn(
    'block w-full px-3 py-1 text-left',
    onClick &&
      'hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
  )
  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick} title={title}>
        {body}
      </button>
    )
  }
  return (
    <div className={className} title={title}>
      {body}
    </div>
  )
}

export function EmptyRow({ text }: { text: string }): React.JSX.Element {
  return <div className="px-3 py-1 text-xs text-muted-foreground">{text}</div>
}

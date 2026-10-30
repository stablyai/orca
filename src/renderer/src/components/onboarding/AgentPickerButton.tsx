import { Check } from 'lucide-react'
import { AgentIcon, type AgentCatalogEntry } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'

export function AgentSectionHeader({
  label,
  count,
  hint
}: {
  label: string
  count: number
  /** Muted line under the label, e.g. how this group opens. */
  hint?: React.ReactNode
}) {
  return (
    <div className="shrink-0 space-y-0.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground/70">{count}</span>
      </div>
      {hint ? <p className="text-[11px] text-muted-foreground/80">{hint}</p> : null}
    </div>
  )
}

export function AgentPickerButton({
  agent,
  selected,
  detail,
  onClick
}: {
  agent: AgentCatalogEntry
  selected: boolean
  /** Muted second line, e.g. where the agent opens. */
  detail?: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      title={agent.label}
      className={cn(
        'flex min-h-[54px] min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected ? 'border-foreground/60 bg-accent' : 'border-border hover:bg-accent/60'
      )}
      onClick={onClick}
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-foreground">
        <AgentIcon agent={agent.id} size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{agent.label}</span>
        {detail ? (
          <span className="mt-0.5 flex min-w-0 items-center gap-1 truncate text-[11px] text-muted-foreground [&_svg]:size-3 [&_svg]:shrink-0">
            {detail}
          </span>
        ) : null}
      </span>
      {selected ? (
        <span className="grid size-4 shrink-0 place-items-center rounded-full bg-foreground text-background">
          <Check className="size-2.5" strokeWidth={3} />
        </span>
      ) : null}
    </button>
  )
}

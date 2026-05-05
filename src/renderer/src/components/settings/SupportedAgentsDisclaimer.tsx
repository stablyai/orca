import type { TuiAgent } from '../../../../shared/types'
import { AGENT_CATALOG, AgentIcon } from '@/lib/agent-catalog'

// Why: agents with a per-agent hook-service module under src/main that posts
// status to the shared agent-hooks server. Keep this list in sync with the
// hook-service.ts files — any agent without one will not appear in the inline
// per-workspace-card agent activity list even when the experimental setting
// is on.
const AGENT_DASHBOARD_SUPPORTED_AGENTS: readonly TuiAgent[] = [
  'claude',
  'codex',
  'gemini',
  'cursor',
  'opencode'
] as const

// Why: both AGENT_DASHBOARD_SUPPORTED_AGENTS and AGENT_CATALOG are static
// module-level constants, so the resolved {id, label} pairs never change at
// runtime. Computing this inside SupportedAgentsDisclaimer was O(N×M) work on
// every parent re-render — notably on every keystroke in the settings search —
// for a list that can only change at build time. Hoisting it makes the cost
// a one-time module-load expense.
const SUPPORTED_AGENT_ENTRIES: readonly { id: TuiAgent; label: string }[] =
  AGENT_DASHBOARD_SUPPORTED_AGENTS.map((id) => {
    const entry = AGENT_CATALOG.find((a) => a.id === id)
    return { id, label: entry?.label ?? id }
  })

export function SupportedAgentsDisclaimer(): React.JSX.Element {
  return (
    <div className="space-y-1 pt-0.5 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span>Supported agents:</span>
        {SUPPORTED_AGENT_ENTRIES.map(({ id, label }) => (
          <span
            key={id}
            className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-muted/40 px-1.5 py-0.5"
            title={label}
          >
            <AgentIcon agent={id} size={12} />
            <span className="text-[11px] leading-none text-foreground/80">{label}</span>
          </span>
        ))}
      </div>
      <p className="text-[11px] italic">
        We&apos;re currently working on support for more agent CLIs.
      </p>
    </div>
  )
}

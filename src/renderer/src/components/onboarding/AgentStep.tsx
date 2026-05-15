import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { AGENT_CATALOG, AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import type { TuiAgent } from '../../../../shared/types'

type AgentStepProps = {
  selectedAgent: TuiAgent | null
  // `fromCollapsedSection` tells the controller whether the click happened
  // under the `<details>` disclosure so `onboarding_agent_picked` can carry
  // it without re-deriving from props at the emit site.
  onSelect: (agent: TuiAgent, fromCollapsedSection: boolean) => void
  detectedSet: Set<TuiAgent>
  isDetecting: boolean
}

export function AgentStep({ selectedAgent, onSelect, detectedSet, isDetecting }: AgentStepProps) {
  const detected = AGENT_CATALOG.filter((agent) => detectedSet.has(agent.id))
  const rest = AGENT_CATALOG.filter((agent) => !detectedSet.has(agent.id))
  const hasDetected = detected.length > 0
  const primary = hasDetected ? detected : AGENT_CATALOG.slice(0, 6)
  const fallbackRest = hasDetected ? rest : AGENT_CATALOG.slice(6)
  const selectedEntry =
    selectedAgent && !detectedSet.has(selectedAgent)
      ? AGENT_CATALOG.find((a) => a.id === selectedAgent)
      : undefined
  // Why: keep the collapsed bucket open when the selected agent lives there, so
  // the active card is visible without forcing the user to expand the disclosure.
  const selectedEntryIsCollapsed =
    selectedAgent != null && fallbackRest.some((a) => a.id === selectedAgent)
  // Why: one-way latch: auto-open when selection lands in the fallback bucket,
  // but never force-close. The user can freely toggle via the native <details>
  // disclosure once it's open; controlling `open` directly off the prop would
  // slam it shut as soon as `selectedEntryIsCollapsed` flips back to false.
  const [openState, setOpenState] = useState(selectedEntryIsCollapsed)
  useEffect(() => {
    if (selectedEntryIsCollapsed) {
      setOpenState(true)
    }
  }, [selectedEntryIsCollapsed])
  return (
    <div className="space-y-5">
      {!hasDetected && !isDetecting && (
        <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-xs text-amber-700 dark:text-amber-200/90">
          No agents detected on your PATH. Pick one to install later, or continue with a blank
          terminal.
        </div>
      )}
      {selectedEntry && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-2.5 text-xs text-amber-700 dark:text-amber-200/90">
          <span>
            <span className="font-medium">{selectedEntry.label}</span> isn&apos;t on your PATH yet.
            Orca will set it as your default and you can install it any time.
          </span>
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-1 font-medium text-amber-800 hover:bg-amber-400/20 dark:text-amber-100"
            onClick={() => void window.api.shell.openUrl(selectedEntry.homepageUrl)}
          >
            Install instructions
            <ExternalLink className="size-3" />
          </button>
        </div>
      )}
      <section className="space-y-3">
        <SectionHeader
          label={hasDetected ? 'Detected on your system' : 'Popular agents'}
          count={primary.length}
        />
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3">
          {primary.map((agent) => (
            <AgentButton
              key={agent.id}
              agent={agent}
              selected={selectedAgent === agent.id}
              onClick={() => onSelect(agent.id, false)}
            />
          ))}
        </div>
      </section>
      {fallbackRest.length > 0 && (
        <details
          className="group space-y-3"
          open={openState}
          onToggle={(e) => setOpenState(e.currentTarget.open)}
        >
          <summary className="cursor-pointer list-none text-xs font-medium text-muted-foreground hover:text-foreground group-open:mb-3">
            Show {fallbackRest.length} more {hasDetected ? 'agents' : ''}→
          </summary>
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3">
            {fallbackRest.map((agent) => (
              <AgentButton
                key={agent.id}
                agent={agent}
                selected={selectedAgent === agent.id}
                onClick={() => onSelect(agent.id, true)}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
      <span>{label}</span>
      <span className="text-muted-foreground/60">·</span>
      <span className="tabular-nums text-muted-foreground">{count}</span>
    </div>
  )
}

function AgentButton({
  agent,
  selected,
  onClick
}: {
  agent: (typeof AGENT_CATALOG)[number]
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        'group relative overflow-hidden rounded-xl border p-3.5 text-left transition-all',
        selected
          ? 'border-foreground/50 bg-muted ring-2 ring-foreground/20'
          : 'border-border bg-muted/30 hover:bg-muted/60'
      )}
      onClick={onClick}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-foreground">
          <AgentIcon agent={agent.id} size={16} />
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{agent.label}</div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {agent.cmd}
          </div>
        </div>
      </div>
    </button>
  )
}

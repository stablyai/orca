import { useLayoutEffect, useRef, useState } from 'react'
import { Check, ExternalLink, Info } from 'lucide-react'
import { getAgentCatalog, AgentIcon, type AgentCatalogEntry } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { TuiAgent } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

const AGENT_GRID_MAX_ROWS = 4

type AgentStepProps = {
  selectedAgent: TuiAgent | null
  // `fromCollapsedSection` tells the controller whether the click happened
  // under the `<details>` disclosure so `onboarding_agent_picked` can carry
  // it without re-deriving from props at the emit site.
  onSelect: (agent: TuiAgent, fromCollapsedSection: boolean) => void
  detectedSet: Set<TuiAgent>
  isDetecting: boolean
  yoloPermissions?: boolean
  onYoloPermissionsChange?: (enabled: boolean) => void
}

function useAgentGridScrollMaxHeight(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  remeasureKey: string
): number | undefined {
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined)

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) {
      return
    }

    const measure = (): void => {
      const card = scroll.querySelector<HTMLElement>('[data-agent-card]')
      const grid = card?.closest<HTMLElement>('[data-agent-grid]')
      if (!card || !grid) {
        setMaxHeight(undefined)
        return
      }
      const gap = Number.parseFloat(getComputedStyle(grid).rowGap || '10')
      const cardHeight = card.getBoundingClientRect().height
      setMaxHeight(Math.ceil(AGENT_GRID_MAX_ROWS * cardHeight + (AGENT_GRID_MAX_ROWS - 1) * gap))
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroll)
    const card = scroll.querySelector<HTMLElement>('[data-agent-card]')
    if (card) {
      observer.observe(card)
    }
    return () => observer.disconnect()
  }, [remeasureKey, scrollRef])

  return maxHeight
}

export function AgentStep({
  selectedAgent,
  onSelect,
  detectedSet,
  isDetecting,
  yoloPermissions = true,
  onYoloPermissionsChange
}: AgentStepProps) {
  const agentCatalog = getAgentCatalog()
  const detected = agentCatalog.filter((agent) => detectedSet.has(agent.id))
  const rest = agentCatalog.filter((agent) => !detectedSet.has(agent.id))
  const hasDetected = detected.length > 0
  const primary = hasDetected ? detected : agentCatalog.slice(0, 6)
  const fallbackRest = hasDetected ? rest : agentCatalog.slice(6)
  const selectedEntry =
    selectedAgent && !detectedSet.has(selectedAgent)
      ? agentCatalog.find((a) => a.id === selectedAgent)
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
  const [previousSelectedEntryIsCollapsed, setPreviousSelectedEntryIsCollapsed] =
    useState(selectedEntryIsCollapsed)
  if (selectedEntryIsCollapsed !== previousSelectedEntryIsCollapsed) {
    setPreviousSelectedEntryIsCollapsed(selectedEntryIsCollapsed)
    if (selectedEntryIsCollapsed && !openState) {
      setOpenState(true)
    }
  }
  const fallbackRestLabel = openState
    ? translate('auto.components.onboarding.AgentStep.hideAgents', 'Hide agents')
    : translate(
        'auto.components.onboarding.AgentStep.showMoreAgents',
        'Show {{value0}} more agents→',
        {
          value0: fallbackRest.length
        }
      )
  const agentGridScrollRef = useRef<HTMLDivElement>(null)
  const agentGridScrollMaxHeight = useAgentGridScrollMaxHeight(
    agentGridScrollRef,
    `${primary.length}:${fallbackRest.length}:${openState}:${hasDetected}`
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      {!hasDetected && !isDetecting && (
        <div className="shrink-0 rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-xs text-amber-700 dark:text-amber-200/90">
          {translate(
            'auto.components.onboarding.AgentStep.1eee1c7bd8',
            'No agents detected on your PATH. Pick one to install later, or continue with a blank terminal.'
          )}
        </div>
      )}
      {selectedEntry && (
        <div className="flex shrink-0 items-center justify-between gap-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-2.5 text-xs text-amber-700 dark:text-amber-200/90">
          <span>
            <span className="font-medium">{selectedEntry.label}</span>{' '}
            {translate(
              'auto.components.onboarding.AgentStep.69af7e9c1c',
              "isn't on your PATH yet. Orca will set it as your default and you can install it any time."
            )}
          </span>
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-1 font-medium text-amber-800 hover:bg-amber-400/20 dark:text-amber-100"
            onClick={() => void window.api.shell.openUrl(selectedEntry.homepageUrl)}
          >
            {translate('auto.components.onboarding.AgentStep.9c163bb0e0', 'Install instructions')}
            <ExternalLink className="size-3" />
          </button>
        </div>
      )}
      <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
        <SectionHeader
          label={
            hasDetected
              ? translate(
                  'auto.components.onboarding.AgentStep.d7b3ef168b',
                  'Detected on your system'
                )
              : translate('auto.components.onboarding.AgentStep.e6a369bd04', 'Popular agents')
          }
          count={primary.length}
          showDetectedIndicator={hasDetected}
        />
        <div
          ref={agentGridScrollRef}
          data-agent-grid-scroll
          className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto pr-1"
          style={agentGridScrollMaxHeight ? { maxHeight: agentGridScrollMaxHeight } : undefined}
        >
          <div className="space-y-3">
            <div data-agent-grid className="grid grid-cols-2 gap-2.5 md:grid-cols-3">
              {primary.map((agent) => (
                <AgentButton
                  key={agent.id}
                  agent={agent}
                  selected={selectedAgent === agent.id}
                  onClick={() => onSelect(agent.id, false)}
                />
              ))}
            </div>
            {fallbackRest.length > 0 && (
              <Collapsible open={openState} onOpenChange={setOpenState}>
                <CollapsibleTrigger className="cursor-pointer text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:mb-3">
                  {fallbackRestLabel}
                </CollapsibleTrigger>
                <CollapsibleContent className="collapsible-height-content">
                  <div data-agent-grid className="grid grid-cols-2 gap-2.5 md:grid-cols-3">
                    {fallbackRest.map((agent) => (
                      <AgentButton
                        key={agent.id}
                        agent={agent}
                        selected={selectedAgent === agent.id}
                        onClick={() => onSelect(agent.id, true)}
                      />
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        </div>
      </section>
      <YoloPermissionsControl
        yoloPermissions={yoloPermissions}
        onYoloPermissionsChange={onYoloPermissionsChange}
      />
    </div>
  )
}

function YoloPermissionsControl({
  yoloPermissions,
  onYoloPermissionsChange
}: {
  yoloPermissions: boolean
  onYoloPermissionsChange?: (enabled: boolean) => void
}): React.JSX.Element {
  return (
    <label className="mt-auto flex shrink-0 cursor-pointer items-center justify-between gap-4 rounded-lg border border-border bg-muted/25 px-4 py-3 transition-colors hover:bg-muted/40">
      <span className="flex min-w-0 items-center gap-3">
        <Checkbox
          checked={yoloPermissions}
          onCheckedChange={(checked) => onYoloPermissionsChange?.(checked === true)}
          className="border-border bg-card data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground"
          aria-label={translate(
            'auto.components.onboarding.AgentStep.yoloPermissionsLabel',
            'Yolo / Dangerously skip permissions'
          )}
        />
        <span className="min-w-0 text-sm font-medium text-foreground">
          {translate(
            'auto.components.onboarding.AgentStep.yoloPermissionsLabel',
            'Yolo / Dangerously skip permissions'
          )}
        </span>
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={translate(
              'auto.components.onboarding.AgentStep.yoloPermissionsInfo',
              'Agent permission info'
            )}
            onPointerDown={(event) => event.preventDefault()}
            className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6} style={{ zIndex: 120 }}>
          {translate(
            'auto.components.onboarding.AgentStep.yoloPermissionsTooltip',
            'Skip permission checks for agents for less interruptions'
          )}
        </TooltipContent>
      </Tooltip>
    </label>
  )
}

function SectionHeader({
  label,
  count,
  showDetectedIndicator = false
}: {
  label: string
  count: number
  showDetectedIndicator?: boolean
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
      {showDetectedIndicator && (
        <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
      )}
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
  agent: AgentCatalogEntry
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-agent-card
      aria-pressed={selected}
      className={cn(
        'group relative overflow-hidden rounded-xl border p-3.5 text-left transition-all',
        selected
          ? 'border-violet-500/60 bg-violet-500/10 ring-2 ring-violet-500/30'
          : 'border-border bg-muted/30 hover:bg-muted/60'
      )}
      onClick={onClick}
    >
      {selected ? (
        <div className="absolute right-2 top-2 grid size-5 place-items-center rounded-full bg-violet-500 text-white shadow-sm">
          <Check className="size-3" strokeWidth={3} />
        </div>
      ) : null}
      <div className="flex min-w-0 items-start gap-2.5 pr-6">
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

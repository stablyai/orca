import { useId, useState } from 'react'
import { Check, ExternalLink } from 'lucide-react'
import { getAgentCatalog, AgentIcon, type AgentCatalogEntry } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Switch } from '@/components/ui/switch'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { translate } from '@/i18n/i18n'

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
        'Show {{value0}} more agents →',
        {
          value0: fallbackRest.length
        }
      )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      {!hasDetected && !isDetecting && (
        <div className="shrink-0 rounded-lg border border-border px-4 py-3 text-xs text-muted-foreground">
          {translate(
            'auto.components.onboarding.AgentStep.1eee1c7bd8',
            'No agents detected on your PATH. Pick one to install later, or continue with a blank terminal.'
          )}
        </div>
      )}
      {selectedEntry && (
        <div className="flex shrink-0 items-center justify-between gap-3 rounded-lg border border-status-warning-border px-4 py-2.5 text-xs text-muted-foreground">
          <span>
            <span className="font-medium text-foreground">{selectedEntry.label}</span>{' '}
            {translate(
              'auto.components.onboarding.AgentStep.69af7e9c1c',
              "isn't on your PATH yet. Orca will set it as your default and you can install it any time."
            )}
          </span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="shrink-0"
            onClick={() => void window.api.shell.openUrl(selectedEntry.homepageUrl)}
          >
            {translate('auto.components.onboarding.AgentStep.9c163bb0e0', 'Install instructions')}
            <ExternalLink className="size-3" />
          </Button>
        </div>
      )}
      <section className="flex min-h-0 flex-col gap-3 overflow-hidden">
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
        />
        <div data-agent-grid-scroll className="scrollbar-sleek min-h-0 overflow-y-auto pr-1">
          <div className="space-y-3">
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
            {fallbackRest.length > 0 && (
              <Collapsible open={openState} onOpenChange={setOpenState}>
                <CollapsibleTrigger className="cursor-pointer text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:mb-3">
                  {fallbackRestLabel}
                </CollapsibleTrigger>
                <CollapsibleContent className="collapsible-height-content">
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
  const switchId = useId()
  return (
    <div className="flex shrink-0 items-center justify-between gap-6 border-t border-border pt-4">
      <label htmlFor={switchId} className="min-w-0 cursor-pointer space-y-0.5">
        <span className="block text-sm font-medium text-foreground">
          {translate('auto.components.onboarding.AgentStep.yoloModeLabel', 'Yolo mode')}
        </span>
        <span className="block text-xs text-muted-foreground">
          {translate(
            'auto.components.onboarding.AgentStep.yoloPermissionsDescription',
            'Agents run commands and edit files without asking, and some also bypass their sandbox. Use only in projects you trust.'
          )}
        </span>
      </label>
      <Switch
        id={switchId}
        checked={yoloPermissions}
        onCheckedChange={(checked) => onYoloPermissionsChange?.(checked)}
      />
    </div>
  )
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <span>{label}</span>
      <span className="tabular-nums text-muted-foreground/70">{count}</span>
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
      aria-pressed={selected}
      title={agent.label}
      className={cn(
        'flex min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected ? 'border-foreground/60 bg-accent' : 'border-border hover:bg-accent/60'
      )}
      onClick={onClick}
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-foreground">
        <AgentIcon agent={agent.id} size={16} />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {agent.label}
      </span>
      {selected ? (
        <span className="grid size-4 shrink-0 place-items-center rounded-full bg-foreground text-background">
          <Check className="size-2.5" strokeWidth={3} />
        </span>
      ) : null}
    </button>
  )
}

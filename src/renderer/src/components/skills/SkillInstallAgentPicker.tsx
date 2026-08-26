import { useState } from 'react'
import { Bot, Check, ChevronsUpDown, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { SkillInstallProviderId } from '../../../../shared/skill-install-providers'
import {
  groupSkillInstallProviders,
  toggledSkillProviderSelection
} from './skill-install-provider-groups'

function AgentRow({
  name,
  directory,
  checked,
  disabled,
  note,
  onCheckedChange
}: {
  name: string
  directory: string
  checked: boolean
  disabled: boolean
  note: string | null
  onCheckedChange?: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <li>
      <label
        className={cn(
          'flex items-center gap-3 rounded-md px-2.5 py-2 text-xs transition-colors select-none',
          disabled ? 'cursor-not-allowed opacity-75' : 'cursor-pointer hover:bg-accent/60'
        )}
      >
        <Checkbox
          checked={checked}
          disabled={disabled}
          aria-label={name}
          onCheckedChange={(value) => onCheckedChange?.(value === true)}
        />
        {/* Why: a fixed name column lines the paths up, so the eye reads one
            list of destinations instead of a ragged edge. */}
        <span className="w-28 shrink-0 truncate font-medium text-foreground">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {directory}
        </span>
        {note ? (
          <span className="shrink-0 rounded bg-muted/70 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {note}
          </span>
        ) : null}
      </label>
    </li>
  )
}

/**
 * Explains canonical .agents/skills consumers in a dedicated header card, while
 * offering clean selectable checkboxes for agents with custom directory placements.
 */
export function SkillInstallAgentPicker({
  id,
  scope,
  selected,
  detectedAgents,
  busy,
  onChange
}: {
  id?: string
  scope: 'global' | 'workspace'
  selected: ReadonlySet<SkillInstallProviderId>
  detectedAgents: readonly string[] | null
  busy: boolean
  onChange: (next: Set<SkillInstallProviderId>) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const { canonical, selectable } = groupSkillInstallProviders(scope, detectedAgents)
  const installed = detectedAgents ? new Set(detectedAgents) : null
  const canonicalRoot = scope === 'global' ? '~/.agents/skills' : '.agents/skills'
  const chosen = [
    ...canonical.map((provider) => provider.displayName),
    ...selectable
      .filter((choice) => selected.has(choice.provider.id))
      .map((choice) => choice.provider.displayName)
  ]

  const selectableChosenCount = selectable.filter((choice) =>
    selected.has(choice.provider.id)
  ).length
  const allSelectableChosen = selectable.length > 0 && selectableChosenCount === selectable.length

  const selectAll = (): void => {
    const next = new Set(selected)
    for (const choice of selectable) {
      next.add(choice.provider.id)
    }
    onChange(next)
  }

  const clearSelectable = (): void => {
    const next = new Set(selected)
    for (const choice of selectable) {
      next.delete(choice.provider.id)
    }
    onChange(next)
  }

  const summaryText =
    chosen.length === 0
      ? translate('auto.components.skills.install.agentsNone', 'No agents selected')
      : translate('auto.components.skills.install.agentsSelected', 'Installing for: {{value0}}', {
          value0: chosen.join(', ')
        })

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>
          {translate('auto.components.skills.install.agentsLabel', 'Agents')}
        </Label>
        <span className="text-[11px] text-muted-foreground">
          {translate('auto.components.skills.install.agentsCountBadge', '{{count}} selected', {
            count: chosen.length
          })}
        </span>
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="button"
            aria-expanded={open}
            aria-label={summaryText}
            disabled={busy}
            title={summaryText}
            className="h-9 w-full min-w-0 justify-between px-3 text-sm font-normal"
          >
            <span className="flex min-w-0 flex-1 items-center gap-2 truncate text-left">
              <Bot className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {chosen.length === 0 ? (
                  <span className="text-muted-foreground">
                    {translate('auto.components.skills.install.agentsNone', 'No agents selected')}
                  </span>
                ) : (
                  <>
                    <span className="font-medium text-foreground">
                      {translate(
                        'auto.components.skills.install.agentsCountLabel',
                        '{{count}} {{label}}',
                        {
                          count: chosen.length,
                          label: chosen.length === 1 ? 'agent' : 'agents'
                        }
                      )}
                    </span>
                    <span className="text-muted-foreground"> · {chosen.join(', ')}</span>
                  </>
                )}
              </span>
            </span>
            <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="popover-wheel-scroll w-[var(--radix-popover-trigger-width)] min-w-[22rem] p-0 shadow-lg"
        >
          {canonical.length > 0 ? (
            <div className="border-b border-border/50 bg-muted/20 px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                <Sparkles className="size-3 text-primary shrink-0" />
                <span>
                  {translate(
                    'auto.components.skills.install.canonicalHeader',
                    'Standard Agents (Always Included)'
                  )}
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-normal text-muted-foreground">
                {translate(
                  'auto.components.skills.install.canonicalExplanation',
                  'These agents natively read {{root}}, which Orca installs to by default:',
                  { root: canonicalRoot }
                )}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {canonical.map((provider) => (
                  <span
                    key={provider.id}
                    className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-background/90 px-2 py-0.5 text-xs font-medium text-foreground shadow-xs"
                  >
                    <Check className="size-3 shrink-0 text-emerald-500" />
                    {provider.displayName}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
            <span className="text-xs font-semibold text-foreground">
              {selectable.length > 0
                ? translate(
                    'auto.components.skills.install.additionalAgentsHeader',
                    'Additional Agent Directories'
                  )
                : translate('auto.components.skills.install.targetAgentsHeader', 'Target Agents')}
            </span>
            {selectable.length > 0 ? (
              <button
                type="button"
                disabled={busy}
                onClick={allSelectableChosen ? clearSelectable : selectAll}
                className="cursor-pointer text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none"
              >
                {allSelectableChosen
                  ? translate('auto.components.skills.install.deselectAll', 'Deselect all')
                  : translate('auto.components.skills.install.selectAll', 'Select all')}
              </button>
            ) : null}
          </div>
          <ul className="scrollbar-sleek max-h-52 overflow-y-auto divide-y divide-border/40 p-1">
            {selectable.map(({ provider, directory }) => (
              <AgentRow
                key={provider.id}
                name={provider.displayName}
                directory={directory}
                checked={selected.has(provider.id)}
                disabled={busy}
                note={
                  installed !== null && !installed.has(provider.id)
                    ? translate('auto.components.skills.install.agentNotInstalled', 'Not installed')
                    : null
                }
                onCheckedChange={(checked) =>
                  onChange(toggledSkillProviderSelection(selected, provider.id, checked))
                }
              />
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  )
}

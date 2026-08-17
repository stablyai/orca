import { ChevronRight } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
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
      <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-xs">
        <Checkbox
          checked={checked}
          disabled={disabled}
          aria-label={name}
          onCheckedChange={(value) => onCheckedChange?.(value === true)}
        />
        {/* Why: a fixed name column lines the paths up, so the eye reads one
            list of destinations instead of a ragged edge. */}
        <span className="w-28 shrink-0 truncate">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {directory}
        </span>
        {note ? <span className="shrink-0 text-[11px] text-muted-foreground">{note}</span> : null}
      </label>
    </li>
  )
}

/**
 * Mirrors the `skills` CLI: one list, where agents that read the canonical
 * `.agents/skills` root at this scope are shown already on and locked, because
 * the canonical copy is written whatever the user picks.
 */
export function SkillInstallAgentPicker({
  scope,
  selected,
  detectedAgents,
  busy,
  onChange
}: {
  scope: 'global' | 'workspace'
  selected: ReadonlySet<SkillInstallProviderId>
  detectedAgents: readonly string[] | null
  busy: boolean
  onChange: (next: Set<SkillInstallProviderId>) => void
}): React.JSX.Element {
  const { canonical, selectable } = groupSkillInstallProviders(scope, detectedAgents)
  const installed = detectedAgents ? new Set(detectedAgents) : null
  const canonicalRoot = scope === 'global' ? '~/.agents/skills' : '.agents/skills'
  const chosen = [
    ...canonical.map((provider) => provider.displayName),
    ...selectable
      .filter((choice) => selected.has(choice.provider.id))
      .map((choice) => choice.provider.displayName)
  ]
  return (
    <Collapsible className="space-y-2">
      <div className="space-y-1">
        <Label>{translate('auto.components.skills.install.agentsLabel', 'Agents')}</Label>
        {/* Why: a full-width row with the chevron trailing, so this disclosure
            and the skill rows above it open the same way. */}
        <CollapsibleTrigger className="group flex w-full items-center gap-3 rounded-md text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">
          <span className="min-w-0 flex-1 truncate">
            {chosen.length === 0
              ? translate('auto.components.skills.install.agentsNone', 'No agents selected')
              : translate(
                  'auto.components.skills.install.agentsSelected',
                  'Installing for: {{value0}}',
                  { value0: chosen.join(', ') }
                )}
          </span>
          <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="collapsible-height-content space-y-2">
        <ul className="divide-y divide-border rounded-md border border-border">
          {canonical.map((provider) => (
            <AgentRow
              key={provider.id}
              name={provider.displayName}
              directory={canonicalRoot}
              checked
              disabled
              note={translate('auto.components.skills.install.agentAlways', 'Always')}
            />
          ))}
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
        {canonical.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.skills.install.agentsCanonicalNote',
              '{{value0}} read {{value1}}, which every install writes.',
              {
                value0: canonical.map((provider) => provider.displayName).join(', '),
                value1: canonicalRoot
              }
            )}
          </p>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}

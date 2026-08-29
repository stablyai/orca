import React from 'react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { AutomationHostLabel, AutomationHostStatusBadges } from './AutomationHostBadges'
import { Field } from './automation-page-parts'
import {
  automationCreateHostEligible,
  automationCreateHostOffered,
  automationCreateUpdateRequiredAuthorityLabels
} from './automation-create-destination'
import { groupAutomationHostEntriesByAuthority } from './automation-host-picker-groups'
import type { AutomationCreateDestinationControl } from './use-automation-create-destination'

// The host that stores and schedules the automation, not the workspace's
// execution host — the two routinely differ. Serves create and edit alike; on an
// existing record a save that lands elsewhere is a move.

export function AutomationDestinationField({
  control,
  labelClassName
}: {
  control: AutomationCreateDestinationControl
  labelClassName?: string
}): React.JSX.Element {
  const selected = control.resolution.status === 'ready' ? control.resolution.entry : null
  // Ineligible hosts stay listed but disabled: hiding them read as the host
  // being gone, and it hid every connected host on a pre-host-scoping server.
  const groups = groupAutomationHostEntriesByAuthority(
    control.entries.filter(automationCreateHostOffered)
  )
  const updateRequiredAuthorities = automationCreateUpdateRequiredAuthorityLabels(control.entries)
  const label = translate('auto.components.automations.createDestination.label', 'Host')

  return (
    <Field label={label} labelClassName={labelClassName}>
      <Select value={selected?.stableKey ?? ''} onValueChange={control.onSelect}>
        <SelectTrigger aria-label={label} className="h-9 w-full min-w-0">
          <SelectValue
            placeholder={translate(
              'auto.components.automations.createDestination.placeholder',
              'Select a host'
            )}
          />
        </SelectTrigger>
        <SelectContent>
          {groups.map((group) => (
            <SelectGroup key={group.authorityKey} data-authority-key={group.authorityKey}>
              <SelectLabel>{group.authorityLabel}</SelectLabel>
              {group.entries.map((entry) => (
                <SelectItem
                  key={entry.stableKey}
                  value={entry.stableKey}
                  disabled={!automationCreateHostEligible(entry)}
                  data-host-stable-key={entry.stableKey}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <AutomationHostLabel entry={entry} className="min-w-0" />
                    <AutomationHostStatusBadges entry={entry} />
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      {selected && control.projects.length === 0 ? (
        // Otherwise Create is disabled for an empty project list with nothing said.
        <p className="text-xs text-destructive" data-testid="automation-create-no-projects">
          {translate(
            'auto.components.automations.createDestination.noProjects',
            'No projects are set up on {host}. Add one there, or choose another host.'
          ).replace('{host}', selected.label)}
        </p>
      ) : control.moveWarning ? (
        // Replaces the storedOn line: both name the same host, and the move is
        // the consequential half.
        <p className="text-xs text-destructive" data-testid="automation-host-move">
          {control.moveWarning}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {selected
            ? translate(
                'auto.components.automations.createDestination.storedOn',
                'Stored and scheduled by {authority}.'
              ).replace('{authority}', selected.authorityLabel)
            : translate(
                'auto.components.automations.createDestination.unselected',
                'Choose the host that stores and schedules this automation.'
              )}
        </p>
      )}
      {updateRequiredAuthorities.length > 0 ? (
        // A disabled row's tooltip is unreachable, so the repair is stated here.
        <p
          className="text-xs text-muted-foreground"
          data-testid="automation-create-update-required"
        >
          {
            // Replacer fn: a literal replacement would expand `$` patterns in host labels.
            translate(
              'auto.components.automations.createDestination.updateRequired',
              'Update the Orca server on {hosts} to store automations there.'
            ).replace('{hosts}', () => updateRequiredAuthorities.join(', '))
          }
        </p>
      ) : null}
    </Field>
  )
}

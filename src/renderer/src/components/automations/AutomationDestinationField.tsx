import React from 'react'
import { HostCombobox } from '@/components/host-picker/HostCombobox'
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

// This host stores/schedules the automation and may differ from workspace execution; saving an existing record elsewhere moves it.

export function AutomationDestinationField({
  control,
  labelClassName
}: {
  control: AutomationCreateDestinationControl
  labelClassName?: string
}): React.JSX.Element {
  const selected = control.resolution.status === 'ready' ? control.resolution.entry : null
  // Keep ineligible hosts visible with reasons, including connected hosts on older servers without host-scoping support.
  const groups = groupAutomationHostEntriesByAuthority(
    control.entries.filter(automationCreateHostOffered)
  )
  const updateRequiredAuthorities = automationCreateUpdateRequiredAuthorityLabels(control.entries)
  const label = translate('auto.components.automations.createDestination.label', 'Host')

  return (
    <Field label={label} labelClassName={labelClassName}>
      <HostCombobox
        notifyOnReselect
        value={selected?.stableKey ?? ''}
        onChange={control.onSelect}
        ariaLabel={label}
        placeholder={translate(
          'auto.components.automations.createDestination.placeholder',
          'Select a host'
        )}
        className="min-w-0"
        options={groups.flatMap((group) =>
          group.entries.map((entry) => ({
            id: entry.stableKey,
            label: entry.label,
            group: group.authorityLabel,
            disabled: !automationCreateHostEligible(entry),
            content: (
              <span
                className="flex min-w-0 flex-1 items-center gap-2"
                data-host-stable-key={entry.stableKey}
              >
                <AutomationHostLabel entry={entry} className="min-w-0" />
                <AutomationHostStatusBadges entry={entry} />
              </span>
            )
          }))
        )}
      />
      {selected && control.projects.length === 0 && !control.recordedProject ? (
        // Otherwise Create is disabled for an empty project list with nothing said.
        <p className="text-xs text-destructive" data-testid="automation-create-no-projects">
          {translate(
            'auto.components.automations.createDestination.noProjects',
            'No projects are set up on {host}. Add one there, or choose another host.'
          ).replace('{host}', selected.label)}
        </p>
      ) : control.moveWarning ? (
        // Prefer the consequential move warning over a duplicate stored-on host label.
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

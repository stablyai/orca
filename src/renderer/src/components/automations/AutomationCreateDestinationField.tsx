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
import { automationCreateHostEligible } from './automation-create-destination'
import { groupAutomationHostEntriesByAuthority } from './automation-host-picker-groups'
import type { AutomationCreateDestinationControl } from './use-automation-create-destination'

/**
 * Where the new automation will be stored, named on the form before submit.
 *
 * This is the storage authority, not the workspace's execution host — the two
 * routinely differ, and only this one decides which machine keeps and schedules
 * the record. A concrete host filter only preselects: the list filter narrows a
 * view, so it must not decide where a new record is allowed to live.
 */

export function AutomationCreateDestinationField({
  control,
  labelClassName
}: {
  control: AutomationCreateDestinationControl
  labelClassName?: string
}): React.JSX.Element {
  const selected = control.resolution.status === 'ready' ? control.resolution.entry : null
  // Offered and resolved by the same predicate, so the list never contains a
  // host that selecting would refuse (e.g. a view-only entry).
  const groups = groupAutomationHostEntriesByAuthority(
    control.entries.filter(automationCreateHostEligible)
  )
  const label = translate('auto.components.automations.createDestination.label', 'Create on')

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
      ) : (
        <p className="text-xs text-muted-foreground">
          {selected
            ? translate(
                'auto.components.automations.createDestination.storedOn',
                'Stored and scheduled by {authority}.'
              ).replace('{authority}', selected.authorityLabel)
            : translate(
                'auto.components.automations.createDestination.unselected',
                'Choose the host this automation will be created on.'
              )}
        </p>
      )}
    </Field>
  )
}

// "Default run on" for a project (spec D7): Last used · This computer · Orca Cloud. Shown only in
// builds that offer Orca Cloud. Stored per Orca profile on this device with the run-on memory.
import React, { useState } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../../../shared/repo-types'
import { useCloudWorkspacesAvailable } from '@/components/cloud-workspaces/use-cloud-workspaces'
import type { RunOnPreference } from '@/components/new-workspace/run-on/cloud-start-model'
import { readRunOnMemory, setRunOnPreference } from '@/lib/orca-cloud/run-on-memory'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import type { SettingsSearchEntry } from '../search/settings-search'

export function getRepositoryRunOnSearchEntry(): SettingsSearchEntry {
  return {
    title: translate('components.settings.repository.runOn.title', 'Default run on'),
    description: translate(
      'components.settings.repository.runOn.description',
      'Where new workspaces in this project start. Orca Cloud is used only when it can start.'
    ),
    keywords: [
      translate('components.settings.repository.runOn.keywordRunOn', 'run on'),
      translate('components.settings.repository.runOn.keywordCloud', 'orca cloud'),
      translate('components.settings.repository.runOn.keywordThisComputer', 'this computer'),
      translate('components.settings.repository.runOn.keywordDefault', 'default')
    ]
  }
}

export function RepositoryRunOnSection({
  repo,
  forceVisible = false
}: {
  repo: Pick<Repo, 'id' | 'displayName'>
  forceVisible?: boolean
}): React.JSX.Element | null {
  const available = useCloudWorkspacesAvailable()
  const profileId = useAppStore((s) => s.activeOrcaProfileId ?? null)
  const [value, setValue] = useState<RunOnPreference>(
    () => readRunOnMemory(profileId, repo.id).preference
  )
  if (available !== true) {
    return null
  }
  const entry = getRepositoryRunOnSearchEntry()
  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={[repo.displayName, ...(entry.keywords ?? [])]}
      className="space-y-3"
      forceVisible={forceVisible}
    >
      <div className="space-y-1">
        <div className="text-sm font-semibold">{entry.title}</div>
        <p className="text-xs text-muted-foreground">{entry.description}</p>
      </div>
      <SettingsSegmentedControl<RunOnPreference>
        value={value}
        onChange={(next) => {
          setValue(next)
          setRunOnPreference(profileId, repo.id, next)
        }}
        ariaLabel={entry.title}
        size="sm"
        options={[
          {
            value: 'last',
            label: translate('components.settings.repository.runOn.last', 'Last used')
          },
          {
            value: 'local',
            label: translate('components.newWorkspace.runOn.thisComputer', 'This computer')
          },
          {
            value: 'orca-cloud',
            label: translate('components.newWorkspace.runOn.orcaCloud', 'Orca Cloud')
          }
        ]}
      />
    </SearchableSetting>
  )
}

import type { SettingsUpdate } from '@/store/slices/settings'
import { RadioGroup, RadioGroupItem } from '../ui/radio-group'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { resolveProjectGroupingMode } from '../../../../shared/project-grouping'
import { SettingsRow } from './SettingsFormControls'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { translate } from '@/i18n/i18n'

function groupingOptions() {
  return [
    {
      value: 'repository' as const,
      label: translate('settings.projectGrouping.repository', 'By repository'),
      description: translate(
        'settings.projectGrouping.repositoryDescription',
        'Every checkout of the same repository is one project, on every host and in every folder.'
      )
    },
    {
      value: 'host' as const,
      label: translate('settings.projectGrouping.host', 'Separate by host'),
      description: translate(
        'settings.projectGrouping.hostDescription',
        'Checkouts on the same host share a project. Each host gets its own project.'
      )
    },
    {
      value: 'folder' as const,
      label: translate('settings.projectGrouping.folder', 'Separate by folder'),
      description: translate(
        'settings.projectGrouping.folderDescription',
        'Every checkout is its own project, so folders on different hosts are separate too.'
      )
    }
  ]
}

export function ProjectGroupingSetting({
  settings,
  updateSettings,
  projectId,
  forceVisible = false
}: {
  settings: GlobalSettings
  updateSettings: (updates: SettingsUpdate) => void
  projectId?: string
  forceVisible?: boolean
}) {
  const options = groupingOptions()
  const mode = resolveProjectGroupingMode(projectId ?? '', settings)
  const title = translate('settings.projectGrouping.label', 'Group checkouts')
  const description = projectId
    ? translate(
        'settings.projectGrouping.overrideDescription',
        'Overrides the default in General for every checkout of this repository.'
      )
    : translate(
        'settings.projectGrouping.description',
        'Choose which checkouts of a Git repository count as one project.'
      )
  const updateOverride = (value: string) => {
    if (!projectId) {
      return
    }
    if (value !== 'default' && value !== 'repository' && value !== 'host' && value !== 'folder') {
      return
    }
    updateSettings((current) => {
      const overrides = { ...current.projectGroupingOverrides }
      if (value === 'default') {
        delete overrides[projectId]
      } else {
        overrides[projectId] = value
      }
      return { projectGroupingOverrides: overrides }
    })
  }
  return (
    <SearchableSetting
      forceVisible={forceVisible}
      title={title}
      description={description}
      keywords={['projects', 'repository', 'host', 'folder', 'group', 'checkout']}
    >
      <SettingsRow
        className={projectId ? undefined : 'flex-col items-stretch'}
        label={title}
        description={description}
        control={
          projectId ? (
            <Select
              value={settings.projectGroupingOverrides?.[projectId] ?? 'default'}
              onValueChange={updateOverride}
            >
              <SelectTrigger className="w-56" aria-label={title}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">
                  {translate('settings.projectGrouping.useDefault', 'Use default ({{mode}})', {
                    mode: options.find(
                      (option) => option.value === (settings.projectGroupingMode ?? 'repository')
                    )?.label
                  })}
                </SelectItem>
                {options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <RadioGroup
              value={mode}
              onValueChange={(value) => {
                if (value === 'repository' || value === 'host' || value === 'folder') {
                  updateSettings({ projectGroupingMode: value })
                }
              }}
              aria-label={title}
              className="space-y-2"
            >
              {options.map((option) => (
                <label
                  key={option.value}
                  className="flex items-start gap-3 rounded-md border border-border p-3"
                >
                  <RadioGroupItem value={option.value} className="mt-0.5" />
                  <span className="space-y-1 text-sm">
                    <span className="block font-medium">{option.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          )
        }
      />
    </SearchableSetting>
  )
}

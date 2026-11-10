import type { SettingsUpdate } from '@/store/slices/settings/create-settings-slice'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { resolveProjectGroupingMode } from '../../../../shared/project-grouping'
import { SettingsRow } from './form-controls/SettingsFormControls'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../ui/select'
import { SearchableSetting } from './section-layout/SearchableSetting'
import { useTranslate, type Translate } from '@/i18n/use-translate'

function groupingOptions(t: Translate) {
  return [
    {
      value: 'repository' as const,
      label: t('settings.projectGrouping.repository', 'By repository')
    },
    {
      value: 'host' as const,
      label: t('settings.projectGrouping.host', 'Separate by host')
    },
    {
      value: 'folder' as const,
      label: t('settings.projectGrouping.folder', 'Separate by folder')
    }
  ]
}

export function ProjectGroupingSetting({
  settings,
  updateSettings,
  projectId,
  forceVisible = false,
  id
}: {
  settings: GlobalSettings
  updateSettings: (updates: SettingsUpdate) => void
  projectId?: string
  forceVisible?: boolean
  id?: string
}) {
  const t = useTranslate()
  const options = groupingOptions(t)
  const mode = resolveProjectGroupingMode(projectId ?? '', settings)
  const title = t('settings.projectGrouping.label', 'Group checkouts')
  const description = projectId
    ? t(
        'settings.projectGrouping.overrideDescription',
        'Overrides the default in General for every checkout of this repository.'
      )
    : t(
        'settings.projectGrouping.description',
        'Choose which checkouts of a Git repository count as one project.'
      )
  const updateMode = (value: string) => {
    if (value !== 'default' && value !== 'repository' && value !== 'host' && value !== 'folder') {
      return
    }
    if (!projectId) {
      if (value !== 'default') {
        updateSettings({ projectGroupingMode: value })
      }
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
      id={id}
      forceVisible={forceVisible}
      title={title}
      description={description}
      keywords={['projects', 'repository', 'host', 'folder', 'group', 'checkout']}
    >
      <SettingsRow
        label={title}
        description={description}
        control={
          <Select
            value={projectId ? (settings.projectGroupingOverrides?.[projectId] ?? 'default') : mode}
            onValueChange={updateMode}
          >
            <SelectTrigger className="w-56" aria-label={title}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {projectId ? (
                <SelectItem value="default">
                  {t('settings.projectGrouping.useDefault', 'Use default ({{mode}})', {
                    mode: options.find(
                      (option) => option.value === (settings.projectGroupingMode ?? 'repository')
                    )?.label
                  })}
                </SelectItem>
              ) : null}
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
    </SearchableSetting>
  )
}

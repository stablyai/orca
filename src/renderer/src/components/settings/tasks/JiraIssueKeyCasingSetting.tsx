import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { JiraIssueKeyCasing } from '../../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import type { Translate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from '../form-controls/SettingsFormControls'

export const JIRA_ISSUE_KEY_CASING_KEYWORDS = [
  'jira',
  'issue key',
  'branch naming',
  'uppercase',
  'lowercase'
]

export function getJiraIssueKeyCasingTitle(t: Translate = translate): string {
  return t('auto.components.settings.GitPane.jiraIssueKeyCasingTitle', 'Jira Key Casing')
}

export function getJiraIssueKeyCasingDescription(t: Translate = translate): string {
  return t(
    'auto.components.settings.GitPane.jiraIssueKeyCasingDescription',
    'Casing of the Jira issue key in the workspace and branch names Orca suggests for new Jira-linked workspaces, such as PROJ-123-fix-login instead of proj-123-fix-login. Existing workspaces and names you type are never changed.'
  )
}

export function JiraIssueKeyCasingSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const value: JiraIssueKeyCasing =
    settings.jiraIssueKeyCasing === 'preserve' ? 'preserve' : 'lowercase'
  const title = getJiraIssueKeyCasingTitle(t)
  const description = getJiraIssueKeyCasingDescription(t)

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={JIRA_ISSUE_KEY_CASING_KEYWORDS}
      className="max-w-none"
    >
      <SettingsRow
        label={title}
        description={description}
        alignTop
        control={
          <SettingsSegmentedControl<JiraIssueKeyCasing>
            value={value}
            onChange={(nextValue) => {
              if (nextValue !== value) {
                void updateSettings({ jiraIssueKeyCasing: nextValue })
              }
            }}
            ariaLabel={title}
            size="sm"
            options={[
              {
                value: 'lowercase',
                label: t(
                  'auto.components.settings.GitPane.jiraIssueKeyCasingLowercase',
                  'Lowercase'
                )
              },
              {
                value: 'preserve',
                label: t(
                  'auto.components.settings.GitPane.jiraIssueKeyCasingPreserve',
                  'Uppercase key'
                )
              }
            ]}
          />
        }
      />
    </SearchableSetting>
  )
}

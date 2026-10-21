import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { JiraIssueKeyCasing } from '../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'

export const JIRA_ISSUE_KEY_CASING_KEYWORDS = [
  'jira',
  'issue key',
  'branch naming',
  'uppercase',
  'lowercase'
]

export function getJiraIssueKeyCasingTitle(): string {
  return translate('auto.components.settings.GitPane.jiraIssueKeyCasingTitle', 'Jira Key Casing')
}

export function getJiraIssueKeyCasingDescription(): string {
  return translate(
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
  const value: JiraIssueKeyCasing =
    settings.jiraIssueKeyCasing === 'preserve' ? 'preserve' : 'lowercase'
  const title = getJiraIssueKeyCasingTitle()
  const description = getJiraIssueKeyCasingDescription()

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
                label: translate(
                  'auto.components.settings.GitPane.jiraIssueKeyCasingLowercase',
                  'Lowercase'
                )
              },
              {
                value: 'preserve',
                label: translate(
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

import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type { SourceControlGroupOrder } from '../../../../../shared/ui-chrome/ui-chrome-types'
import type { SourceControlAiSettingsPatch } from '../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'
import { normalizeSourceControlGroupOrder } from '../../../../../shared/source-control/listing/source-control-group-order'
import { useAppStore } from '../../../store/index'

import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { BranchPrefixSetting } from './BranchPrefixSetting'
import type { SettingsHostScope } from '../host-scope/settings-host-scope'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { matchesSettingsSearch } from '../search/settings-search'
import { AutoRenameBranchFromWorkSetting } from './AutoRenameBranchFromWorkSetting'
import {
  JIRA_ISSUE_KEY_CASING_KEYWORDS,
  JiraIssueKeyCasingSetting,
  getJiraIssueKeyCasingDescription,
  getJiraIssueKeyCasingTitle
} from '../tasks/JiraIssueKeyCasingSetting'
import {
  CompareAgainstUpstreamSetting,
  compareAgainstUpstreamMatchesSearch
} from './CompareAgainstUpstreamSetting'
import { getAutoRenameBranchSearchEntries } from './auto-rename-branch-search'
import { getKeepLocalMainUpToDateTitle } from './keep-local-main-up-to-date-setting'
import {
  KEEP_LOCAL_MAIN_UP_TO_DATE_DESCRIPTION,
  KEEP_LOCAL_MAIN_UP_TO_DATE_KEYWORDS,
  KeepLocalMainUpToDateSetting
} from './KeepLocalMainUpToDateSetting'
import { useTranslate } from '@/i18n/use-translate'
import { SettingsRow, SettingsSegmentedControl } from '../form-controls/SettingsFormControls'

const SOURCE_CONTROL_GROUP_ORDER_KEYWORDS = [
  'group order',
  'changes first',
  'staged first',
  'untracked first',
  'source control',
  'git changes'
]

export function shouldShowAutoRenameBranchSetting(
  searchQuery: string,
  hasUnsavedBranchPromptChanges: boolean
): boolean {
  return (
    hasUnsavedBranchPromptChanges ||
    matchesSettingsSearch(searchQuery, getAutoRenameBranchSearchEntries())
  )
}

type GitPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  writeSourceControlAiSettings: (patch: SourceControlAiSettingsPatch) => Promise<void>
  displayedGitUsername: string
  /** The host whose workspace creates read the branch rows. */
  hostScope: SettingsHostScope
  hasUnsavedBranchPromptChanges?: boolean
  onBranchPromptDirtyChange?: (dirty: boolean) => void
  branchPromptDiscardSignal?: number
  settingsSearchQuery?: string
}

export function SourceControlGroupOrderSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const value = normalizeSourceControlGroupOrder(settings.sourceControlGroupOrder)
  const title = t('auto.components.settings.GitPane.53a0daed73', 'Source control group order')
  const description = t(
    'auto.components.settings.GitPane.sourceControlGroupOrderDescription',
    'Choose whether Staged Changes or Changes appear first in Source Control.'
  )

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={SOURCE_CONTROL_GROUP_ORDER_KEYWORDS}
      className="max-w-none"
    >
      <SettingsRow
        label={title}
        description={description}
        alignTop
        control={
          <SettingsSegmentedControl<SourceControlGroupOrder>
            value={value}
            onChange={(nextValue) => {
              if (nextValue !== value) {
                void updateSettings({ sourceControlGroupOrder: nextValue })
              }
            }}
            ariaLabel={title}
            size="sm"
            options={[
              {
                value: 'changes-first',
                label: t('auto.components.settings.GitPane.changesFirst', 'Changes first')
              },
              {
                value: 'staged-first',
                label: t('auto.components.settings.GitPane.stagedFirst', 'Staged first')
              }
            ]}
          />
        }
      />
    </SearchableSetting>
  )
}

export function GitPane({
  settings,
  updateSettings,
  writeSourceControlAiSettings,
  displayedGitUsername,
  hostScope,
  hasUnsavedBranchPromptChanges = false,
  onBranchPromptDirtyChange,
  branchPromptDiscardSignal,
  settingsSearchQuery
}: GitPaneProps): React.JSX.Element | null {
  const t = useTranslate()
  const storeSearchQuery = useAppStore((s) => s.settingsSearchQuery)
  const searchQuery = settingsSearchQuery ?? storeSearchQuery
  const keepLocalMainUpToDateTitle = getKeepLocalMainUpToDateTitle(t)

  const visibleSections = [
    matchesSettingsSearch(searchQuery, {
      title: t('auto.components.settings.GitPane.7826f35f63', 'Branch prefix'),
      description: t(
        'auto.components.settings.GitPane.1ffaadf0a0',
        'Prefix added to branch names when creating worktrees.'
      ),
      keywords: [
        t('auto.components.settings.GitPane.cc63fce906', 'branch naming'),
        t('auto.components.settings.GitPane.2351aa5a31', 'git username'),
        t('auto.components.settings.GitPane.813e15b346', 'custom')
      ]
    }) ? (
      <BranchPrefixSetting
        // A fresh row per host, so one host's unsaved draft never shows on another.
        key={`branch-prefix:${runtimeTargetEnvironmentId(hostScope.target) ?? 'local'}`}
        hostScope={hostScope}
        settings={settings}
        updateSettings={updateSettings}
        displayedGitUsername={displayedGitUsername}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, {
      title: getJiraIssueKeyCasingTitle(t),
      description: getJiraIssueKeyCasingDescription(t),
      keywords: JIRA_ISSUE_KEY_CASING_KEYWORDS
    }) ? (
      <JiraIssueKeyCasingSetting
        key="jira-issue-key-casing"
        settings={settings}
        updateSettings={updateSettings}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, {
      title: keepLocalMainUpToDateTitle,
      description: KEEP_LOCAL_MAIN_UP_TO_DATE_DESCRIPTION,
      keywords: KEEP_LOCAL_MAIN_UP_TO_DATE_KEYWORDS
    }) ? (
      <KeepLocalMainUpToDateSetting
        key={`refresh-base-ref:${runtimeTargetEnvironmentId(hostScope.target) ?? 'local'}`}
        hostScope={hostScope}
        settings={settings}
        updateSettings={updateSettings}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, {
      title: t('auto.components.settings.GitPane.53a0daed73', 'Source control group order'),
      description: t(
        'auto.components.settings.GitPane.sourceControlGroupOrderDescription',
        'Choose whether Staged Changes or Changes appear first in Source Control.'
      ),
      keywords: SOURCE_CONTROL_GROUP_ORDER_KEYWORDS
    }) ? (
      <SourceControlGroupOrderSetting
        key="source-control-group-order"
        settings={settings}
        updateSettings={updateSettings}
      />
    ) : null,
    compareAgainstUpstreamMatchesSearch(searchQuery, t) ? (
      <CompareAgainstUpstreamSetting
        key="compare-against-upstream"
        settings={settings}
        updateSettings={updateSettings}
      />
    ) : null,
    shouldShowAutoRenameBranchSetting(searchQuery, hasUnsavedBranchPromptChanges) ? (
      <AutoRenameBranchFromWorkSetting
        key="auto-rename-branch-from-work"
        settings={settings}
        updateSettings={updateSettings}
        writeSourceControlAiSettings={writeSourceControlAiSettings}
        forceVisible={hasUnsavedBranchPromptChanges}
        onBranchPromptDirtyChange={onBranchPromptDirtyChange}
        branchPromptDiscardSignal={branchPromptDiscardSignal}
        settingsSearchQuery={searchQuery}
      />
    ) : null
  ].filter(Boolean)

  if (visibleSections.length === 0) {
    return null
  }

  return <SettingsGroup>{visibleSections}</SettingsGroup>
}

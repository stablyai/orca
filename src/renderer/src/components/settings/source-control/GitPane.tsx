import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { SourceControlGroupOrder } from '../../../../../shared/ui-chrome-types'
import type { SourceControlAiSettingsPatch } from '../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'
import { normalizeSourceControlGroupOrder } from '../../../../../shared/source-control/listing/source-control-group-order'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Switch } from '../../ui/switch'
import { useAppStore } from '../../../store/index'

import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { BranchPrefixFeedback } from './BranchPrefixFeedback'
import { matchesSettingsSearch } from '../search/settings-search'
import { AutoRenameBranchFromWorkSetting } from './AutoRenameBranchFromWorkSetting'
import { WorkspaceIconSetting } from './WorkspaceIconSetting'
import { getWorkspaceIconSearchEntry } from './workspace-icon-search'
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
import {
  KEEP_LOCAL_MAIN_UP_TO_DATE_SECTION_ID,
  getKeepLocalMainUpToDateTitle
} from './keep-local-main-up-to-date-setting'
import { Trans } from 'react-i18next'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { SettingsRow, SettingsSegmentedControl } from '../form-controls/SettingsFormControls'

const KEEP_LOCAL_MAIN_UP_TO_DATE_DESCRIPTION =
  'When you create a workspace, Orca refreshes the remote base and safely fast-forwards your matching local branch, such as main or master. This keeps commands like git diff main...HEAD from comparing against stale history. Orca skips the update if that branch has uncommitted changes or local-only commits.'
const KEEP_LOCAL_MAIN_UP_TO_DATE_KEYWORDS = [
  'main',
  'master',
  'origin/main',
  'git diff',
  'behind main',
  'up to date',
  'stale main',
  'refresh local main',
  'base ref',
  'fresh base',
  'safely',
  'worktree'
]
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
  hasUnsavedBranchPromptChanges = false,
  onBranchPromptDirtyChange,
  branchPromptDiscardSignal,
  settingsSearchQuery
}: GitPaneProps): React.JSX.Element | null {
  const t = useTranslate()
  const branchPrefixInputId = useId()
  const storeSearchQuery = useAppStore((s) => s.settingsSearchQuery)
  const searchQuery = settingsSearchQuery ?? storeSearchQuery
  const keepLocalMainUpToDateTitle = getKeepLocalMainUpToDateTitle(t)
  // The branch prompt and icon recipe share the page's single Git dirty guard.
  const dirtyPartsRef = useRef({ branch: false, icon: false })
  const reportBranchDirty = useCallback(
    (dirty: boolean): void => {
      dirtyPartsRef.current.branch = dirty
      onBranchPromptDirtyChange?.(dirty || dirtyPartsRef.current.icon)
    },
    [onBranchPromptDirtyChange]
  )
  const reportIconDirty = useCallback(
    (dirty: boolean): void => {
      dirtyPartsRef.current.icon = dirty
      onBranchPromptDirtyChange?.(dirty || dirtyPartsRef.current.branch)
    },
    [onBranchPromptDirtyChange]
  )

  const isBranchPrefixInputMode = settings.branchPrefix !== 'none'
  // Local drafts preserve caret/fast typing through async IPC; adopt external reloads but ignore delayed echoes of our own edits.
  const [customPrefixDraft, setCustomPrefixDraft] = useState(settings.branchPrefixCustom)
  const lastCommittedPrefixRef = useRef(settings.branchPrefixCustom)
  useEffect(() => {
    if (settings.branchPrefixCustom !== lastCommittedPrefixRef.current) {
      lastCommittedPrefixRef.current = settings.branchPrefixCustom
      setCustomPrefixDraft(settings.branchPrefixCustom)
    }
  }, [settings.branchPrefixCustom])
  const branchPrefixInputValue =
    settings.branchPrefix === 'git-username' ? displayedGitUsername : customPrefixDraft

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
      <SearchableSetting
        key="branch-prefix"
        title={t('auto.components.settings.GitPane.7826f35f63', 'Branch prefix')}
        description={t(
          'auto.components.settings.GitPane.1ffaadf0a0',
          'Prefix added to branch names when creating worktrees.'
        )}
        keywords={['branch naming', 'git username', 'custom']}
        className="space-y-3 py-3"
      >
        <div className="space-y-0.5">
          <Label htmlFor={branchPrefixInputId}>
            {t('auto.components.settings.GitPane.7826f35f63', 'Branch prefix')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.GitPane.1ec5c91e1d',
              'Choose whether branch names use your Git username, a custom prefix, or no prefix.'
            )}
          </p>
        </div>
        <div className="flex w-fit gap-1 rounded-md border border-border/50 p-1">
          {(['git-username', 'custom', 'none'] as const).map((option) => (
            <button
              key={option}
              onClick={() => updateSettings({ branchPrefix: option })}
              className={`rounded-sm px-3 py-1 text-sm transition-colors ${
                settings.branchPrefix === option
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {option === 'git-username'
                ? t('auto.components.settings.GitPane.d12c81a103', 'Git username')
                : option === 'custom'
                  ? t('auto.components.settings.GitPane.1f32ba27a6', 'Custom')
                  : t('auto.components.settings.GitPane.3d172725cc', 'None')}
            </button>
          ))}
        </div>
        {isBranchPrefixInputMode && (
          <Input
            id={branchPrefixInputId}
            value={branchPrefixInputValue}
            onChange={(e) => {
              const next = e.target.value
              lastCommittedPrefixRef.current = next
              setCustomPrefixDraft(next)
              updateSettings({ branchPrefixCustom: next })
            }}
            placeholder={
              settings.branchPrefix === 'git-username'
                ? t('auto.components.settings.GitPane.aefa1ecb59', 'No git username configured')
                : t('auto.components.settings.GitPane.b559bf9899', 'e.g. feature')
            }
            className="max-w-xs"
            readOnly={settings.branchPrefix === 'git-username'}
          />
        )}
        {isBranchPrefixInputMode && <BranchPrefixFeedback rawPrefix={branchPrefixInputValue} />}
      </SearchableSetting>
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
      <SearchableSetting
        key="refresh-base-ref"
        id={KEEP_LOCAL_MAIN_UP_TO_DATE_SECTION_ID}
        title={keepLocalMainUpToDateTitle}
        description={KEEP_LOCAL_MAIN_UP_TO_DATE_DESCRIPTION}
        keywords={KEEP_LOCAL_MAIN_UP_TO_DATE_KEYWORDS}
        className="flex items-center justify-between gap-4 py-3"
      >
        <div className="space-y-0.5">
          <Label>{keepLocalMainUpToDateTitle}</Label>
          <p className="text-xs text-muted-foreground">
            <Trans
              i18n={i18n}
              defaults={t(
                'auto.components.settings.GitPane.refreshLocalBaseDescription',
                'When you create a workspace, Orca refreshes the remote base and safely fast-forwards your matching local branch, such as <mainBranch>main</mainBranch> or <masterBranch>master</masterBranch>. This keeps commands like <diffCommand>git diff main...HEAD</diffCommand> from comparing against stale history. Orca skips the update if that branch has uncommitted changes or local-only commits.'
              )}
              components={{
                mainBranch: <code />,
                masterBranch: <code />,
                diffCommand: <code />
              }}
            />
          </p>
        </div>
        <Switch
          aria-label={keepLocalMainUpToDateTitle}
          checked={settings.refreshLocalBaseRefOnWorktreeCreate}
          onCheckedChange={(checked) =>
            updateSettings({
              refreshLocalBaseRefOnWorktreeCreate: checked
            })
          }
        />
      </SearchableSetting>
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
        onBranchPromptDirtyChange={reportBranchDirty}
        branchPromptDiscardSignal={branchPromptDiscardSignal}
        settingsSearchQuery={searchQuery}
      />
    ) : null,
    hasUnsavedBranchPromptChanges ||
    matchesSettingsSearch(searchQuery, getWorkspaceIconSearchEntry()) ? (
      <WorkspaceIconSetting
        key={`workspace-icon-${branchPromptDiscardSignal ?? 0}`}
        settings={settings}
        writeSourceControlAiSettings={writeSourceControlAiSettings}
        onDirtyChange={reportIconDirty}
        forceVisible={hasUnsavedBranchPromptChanges}
      />
    ) : null
  ].filter(Boolean)

  if (visibleSections.length === 0) {
    return null
  }

  return <SettingsGroup>{visibleSections}</SettingsGroup>
}

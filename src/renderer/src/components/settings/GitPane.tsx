import { useEffect, useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { SourceControlGroupOrder } from '../../../../shared/ui-chrome-types'
import type { SourceControlAiSettingsPatch } from '../../../../shared/source-control-ai-types'
import { DEFAULT_SOURCE_CONTROL_GROUP_ORDER } from '../../../../shared/source-control-group-order'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { useAppStore } from '../../store'
import { getGitPaneSearchEntries } from './git-search'
import { SearchableSetting } from './SearchableSetting'
import { BranchPrefixFeedback } from './BranchPrefixFeedback'
import { matchesSettingsSearch } from './settings-search'
import { AutoRenameBranchFromWorkSetting } from './AutoRenameBranchFromWorkSetting'
import {
  CompareAgainstUpstreamSetting,
  compareAgainstUpstreamMatchesSearch
} from './CompareAgainstUpstreamSetting'
import { getAutoRenameBranchSearchEntries } from './auto-rename-branch-search'
import {
  KEEP_LOCAL_MAIN_UP_TO_DATE_SECTION_ID,
  getKeepLocalMainUpToDateTitle
} from './keep-local-main-up-to-date-setting'
import { translate } from '@/i18n/i18n'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'

export { getGitPaneSearchEntries }

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
  const value = settings.sourceControlGroupOrder ?? DEFAULT_SOURCE_CONTROL_GROUP_ORDER
  const title = translate(
    'auto.components.settings.GitPane.sourceControlGroupOrderTitle',
    'Source Control Group Order'
  )
  const description = translate(
    'auto.components.settings.GitPane.sourceControlGroupOrderDescription',
    'Choose whether Changes, Staged Changes, or Untracked Files appear first in Source Control.'
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
                label: translate('auto.components.settings.GitPane.changesFirst', 'Changes first')
              },
              {
                value: 'staged-first',
                label: translate('auto.components.settings.GitPane.stagedFirst', 'Staged first')
              },
              {
                value: 'untracked-first',
                label: translate(
                  'auto.components.settings.GitPane.untrackedFirst',
                  'Untracked first'
                )
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
}: GitPaneProps): React.JSX.Element {
  const storeSearchQuery = useAppStore((s) => s.settingsSearchQuery)
  const searchQuery = settingsSearchQuery ?? storeSearchQuery
  const keepLocalMainUpToDateTitle = getKeepLocalMainUpToDateTitle()

  const isBranchPrefixInputMode = settings.branchPrefix !== 'none'
  // Local draft for the editable custom prefix: updateSettings persists through
  // an async IPC round-trip, so a directly-controlled value would only reflect
  // the edit a tick later and React would then re-assign it, snapping the caret
  // to the end. The draft keeps the caret put; the ref guard adopts only genuine
  // external changes (settings reloaded/reset), not the async echo of our own
  // keystrokes, which would clobber fast typing on slow (SSH) round-trips.
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
      title: translate('auto.components.settings.GitPane.330f584b50', 'Branch Prefix'),
      description: translate(
        'auto.components.settings.GitPane.1ffaadf0a0',
        'Prefix added to branch names when creating worktrees.'
      ),
      keywords: [
        translate('auto.components.settings.GitPane.cc63fce906', 'branch naming'),
        translate('auto.components.settings.GitPane.2351aa5a31', 'git username'),
        translate('auto.components.settings.GitPane.813e15b346', 'custom')
      ]
    }) ? (
      <SearchableSetting
        key="branch-prefix"
        title={translate('auto.components.settings.GitPane.330f584b50', 'Branch Prefix')}
        description={translate(
          'auto.components.settings.GitPane.1ffaadf0a0',
          'Prefix added to branch names when creating worktrees.'
        )}
        keywords={['branch naming', 'git username', 'custom']}
        className="space-y-3"
      >
        <div className="space-y-0.5">
          <Label>{translate('auto.components.settings.GitPane.330f584b50', 'Branch Prefix')}</Label>
          <p className="text-xs text-muted-foreground">
            {translate(
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
                ? translate('auto.components.settings.GitPane.a182c5125e', 'Git Username')
                : option === 'custom'
                  ? translate('auto.components.settings.GitPane.1f32ba27a6', 'Custom')
                  : translate('auto.components.settings.GitPane.3d172725cc', 'None')}
            </button>
          ))}
        </div>
        {isBranchPrefixInputMode && (
          <Input
            value={branchPrefixInputValue}
            onChange={(e) => {
              const next = e.target.value
              lastCommittedPrefixRef.current = next
              setCustomPrefixDraft(next)
              updateSettings({ branchPrefixCustom: next })
            }}
            placeholder={
              settings.branchPrefix === 'git-username'
                ? translate(
                    'auto.components.settings.GitPane.aefa1ecb59',
                    'No git username configured'
                  )
                : translate('auto.components.settings.GitPane.b559bf9899', 'e.g. feature')
            }
            className="max-w-xs"
            readOnly={settings.branchPrefix === 'git-username'}
          />
        )}
        {isBranchPrefixInputMode && <BranchPrefixFeedback rawPrefix={branchPrefixInputValue} />}
      </SearchableSetting>
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
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="space-y-0.5">
          <Label>{keepLocalMainUpToDateTitle}</Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.GitPane.976afc6b3e',
              'When you create a workspace, Orca refreshes the remote base and safely fast-forwards your matching local branch, such as'
            )}{' '}
            <code>{translate('auto.components.settings.GitPane.ffba483bae', 'main')}</code>{' '}
            {translate('auto.components.settings.GitPane.5bf885be48', 'or')}{' '}
            <code>{translate('auto.components.settings.GitPane.3ae3de8898', 'master')}</code>
            {translate(
              'auto.components.settings.GitPane.db3a127eb1',
              '. This keeps commands like'
            )}{' '}
            <code>
              {translate('auto.components.settings.GitPane.d072a12995', 'git diff main...HEAD')}
            </code>{' '}
            {translate(
              'auto.components.settings.GitPane.36e3de3619',
              'from comparing against stale history. Orca skips the update if that branch has uncommitted changes or local-only commits.'
            )}
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
      title: translate(
        'auto.components.settings.GitPane.sourceControlGroupOrderTitle',
        'Source Control Group Order'
      ),
      description: translate(
        'auto.components.settings.GitPane.sourceControlGroupOrderDescription',
        'Choose whether Changes, Staged Changes, or Untracked Files appear first in Source Control.'
      ),
      keywords: SOURCE_CONTROL_GROUP_ORDER_KEYWORDS
    }) ? (
      <SourceControlGroupOrderSetting
        key="source-control-group-order"
        settings={settings}
        updateSettings={updateSettings}
      />
    ) : null,
    compareAgainstUpstreamMatchesSearch(searchQuery) ? (
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

  return <div className="space-y-4">{visibleSections}</div>
}

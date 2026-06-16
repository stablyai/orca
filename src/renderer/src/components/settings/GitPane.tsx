import type { GlobalSettings } from '../../../../shared/types'
import type { SourceControlAiSettingsPatch } from '../../../../shared/source-control-ai-types'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { useAppStore } from '../../store'
import { getGitPaneSearchEntries } from './git-search'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { AutoRenameBranchFromWorkSetting } from './AutoRenameBranchFromWorkSetting'
import { getAutoRenameBranchSearchEntries } from './auto-rename-branch-search'
import {
  KEEP_LOCAL_MAIN_UP_TO_DATE_SECTION_ID,
  getKeepLocalMainUpToDateTitle
} from './keep-local-main-up-to-date-setting'
import { translate } from '@/i18n/i18n'

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
        {(settings.branchPrefix === 'custom' || settings.branchPrefix === 'git-username') && (
          <Input
            value={
              settings.branchPrefix === 'git-username'
                ? displayedGitUsername
                : settings.branchPrefixCustom
            }
            onChange={(e) => updateSettings({ branchPrefixCustom: e.target.value })}
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
            )}
            <code>{translate('auto.components.settings.GitPane.ffba483bae', 'main')}</code>{' '}
            {translate('auto.components.settings.GitPane.5bf885be48', 'or')}
            <code>{translate('auto.components.settings.GitPane.3ae3de8898', 'master')}</code>
            {translate('auto.components.settings.GitPane.db3a127eb1', '. This keeps commands like')}
            <code>
              {translate('auto.components.settings.GitPane.d072a12995', 'git diff main...HEAD')}
            </code>{' '}
            {translate(
              'auto.components.settings.GitPane.36e3de3619',
              'from comparing against stale history. Orca skips the update if that branch has uncommitted changes or local-only commits.'
            )}
          </p>
        </div>
        <button
          role="switch"
          aria-checked={settings.refreshLocalBaseRefOnWorktreeCreate}
          onClick={() =>
            updateSettings({
              refreshLocalBaseRefOnWorktreeCreate: !settings.refreshLocalBaseRefOnWorktreeCreate
            })
          }
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
            settings.refreshLocalBaseRefOnWorktreeCreate
              ? 'bg-foreground'
              : 'bg-muted-foreground/30'
          }`}
        >
          <span
            className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
              settings.refreshLocalBaseRefOnWorktreeCreate ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </SearchableSetting>
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
    ) : null,
    matchesSettingsSearch(searchQuery, {
      title: translate('auto.components.settings.GitPane.e02ea23a32', 'Orca Attribution'),
      description: translate(
        'auto.components.settings.GitPane.d2eede4c54',
        'Add Orca attribution to commits, PRs, and issues.'
      ),
      keywords: [
        translate('auto.components.settings.GitPane.32dca11189', 'github'),
        translate('auto.components.settings.GitPane.895d3f70b8', 'gh'),
        translate('auto.components.settings.GitPane.b4ef5428a7', 'pr'),
        translate('auto.components.settings.GitPane.afada55042', 'issue'),
        translate('auto.components.settings.GitPane.9838c921ed', 'co-author'),
        translate('auto.components.settings.GitPane.b5f534717a', 'coauthored'),
        translate('auto.components.settings.GitPane.b9b5771bb1', 'attribution'),
        translate('auto.components.settings.GitPane.e71ce09c42', 'orca')
      ]
    }) ? (
      <SearchableSetting
        key="github-attribution"
        title={translate('auto.components.settings.GitPane.e02ea23a32', 'Orca Attribution')}
        description={translate(
          'auto.components.settings.GitPane.d2eede4c54',
          'Add Orca attribution to commits, PRs, and issues.'
        )}
        keywords={['github', 'gh', 'pr', 'issue', 'co-author', 'coauthored', 'attribution', 'orca']}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="space-y-0.5">
          <Label>
            {translate('auto.components.settings.GitPane.e02ea23a32', 'Orca Attribution')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.GitPane.d2eede4c54',
              'Add Orca attribution to commits, PRs, and issues.'
            )}
          </p>
        </div>
        <button
          role="switch"
          aria-checked={settings.enableGitHubAttribution}
          onClick={() =>
            updateSettings({
              enableGitHubAttribution: !settings.enableGitHubAttribution
            })
          }
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
            settings.enableGitHubAttribution ? 'bg-foreground' : 'bg-muted-foreground/30'
          }`}
        >
          <span
            className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
              settings.enableGitHubAttribution ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </SearchableSetting>
    ) : null
  ].filter(Boolean)

  return <div className="space-y-4">{visibleSections}</div>
}

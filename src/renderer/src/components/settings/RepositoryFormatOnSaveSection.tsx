import type React from 'react'
import { useRef, useState } from 'react'
import type { Repo, RepoFormatOnSaveSettings } from '../../../../shared/repo-types'
import {
  formatOnSaveIncludeToInput,
  getDefaultRepoFormatOnSaveSettings,
  normalizeRepoFormatOnSaveSettings,
  parseFormatOnSaveIncludeInput,
  SUGGESTED_FORMAT_ON_SAVE_COMMAND,
  SUGGESTED_FORMAT_ON_SAVE_INCLUDE
} from '../../../../shared/format-on-save-command'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { matchesRepositoryIdentitySearch } from './repository-identity-search'
import { getRepositoryFormatOnSaveSearchEntries } from './repository-format-on-save-search-entries'
import { SettingsSubsectionHeader, SettingsSwitchRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

type RepositoryFormatOnSaveSectionProps = {
  repo: Repo
  searchQuery: string
  onUpdateFormatOnSave: (next: RepoFormatOnSaveSettings) => void
}

export function RepositoryFormatOnSaveSection({
  repo,
  searchQuery,
  onUpdateFormatOnSave
}: RepositoryFormatOnSaveSectionProps): React.JSX.Element | null {
  // Why: a project-name search is navigation to the project, so it shows the whole pane.
  const forceVisible = matchesRepositoryIdentitySearch(searchQuery, repo)
  const settings = normalizeRepoFormatOnSaveSettings(
    repo.formatOnSave ?? getDefaultRepoFormatOnSaveSettings()
  )
  // Why: SSH hosts format through the relay's non-interactive exec channel;
  // runtime environments have no equivalent, so only those are called out.
  const executionHost = parseExecutionHostId(getRepoExecutionHostId(repo))
  const isRuntimeHost = executionHost?.kind === 'runtime'

  const includeInput = formatOnSaveIncludeToInput(settings.include)
  const [commandDraft, setCommandDraft] = useState(settings.command)
  const [includeDraft, setIncludeDraft] = useState(includeInput)
  const [committedCommand, setCommittedCommand] = useState(settings.command)
  const [committedInclude, setCommittedInclude] = useState(includeInput)

  // Why: the repo record can change outside this pane (another window, a sync);
  // reconcile before paint so the inputs never show a stale value. Each field
  // resets only when its own stored value moved, so an unfinished edit in the
  // other one survives.
  if (committedCommand !== settings.command) {
    setCommittedCommand(settings.command)
    setCommandDraft(settings.command)
  }
  if (committedInclude !== includeInput) {
    setCommittedInclude(includeInput)
    setIncludeDraft(includeInput)
  }

  const hasCommand = settings.command.trim().length > 0
  const commandInputRef = useRef<HTMLInputElement>(null)
  const [needsCommand, setNeedsCommand] = useState(false)
  const [nudging, setNudging] = useState(false)

  // Why: the switch cannot turn on without a command, so a click points at the
  // field that is missing instead of springing back with no explanation.
  const handleToggle = (): void => {
    if (!hasCommand) {
      setNeedsCommand(true)
      setNudging(true)
      commandInputRef.current?.focus()
      return
    }
    setNeedsCommand(false)
    onUpdateFormatOnSave(
      normalizeRepoFormatOnSaveSettings({ ...settings, enabled: !settings.enabled })
    )
  }

  const commitCommand = (): void => {
    const command = commandDraft.trim()
    if (command === settings.command) {
      return
    }
    // Why: normalize on write too, so a command-less config never persists
    // `enabled: true` — a state the reader would silently correct anyway.
    onUpdateFormatOnSave(normalizeRepoFormatOnSaveSettings({ ...settings, command }))
  }

  const commitInclude = (): void => {
    const include = parseFormatOnSaveIncludeInput(includeDraft)
    if (formatOnSaveIncludeToInput(include) === formatOnSaveIncludeToInput(settings.include)) {
      return
    }
    onUpdateFormatOnSave({ ...settings, include })
  }

  const enableLabel = translate(
    'auto.components.settings.RepositoryFormatOnSaveSection.enableTitle',
    'Format on Save'
  )
  const enableDescription = translate(
    'auto.components.settings.RepositoryFormatOnSaveSection.enableDescription',
    "Run this project's formatter after Orca saves a file in this repository."
  )

  // Why: after every hook, so a search that excludes the section only skips the markup.
  if (
    !forceVisible &&
    !matchesSettingsSearch(searchQuery, getRepositoryFormatOnSaveSearchEntries(repo))
  ) {
    return null
  }

  return (
    <section key="format-on-save" className="space-y-4">
      <SettingsSubsectionHeader
        title={enableLabel}
        description={translate(
          'auto.components.settings.RepositoryFormatOnSaveSection.sectionDescription',
          'Orca runs the command in the worktree root after each save, so the project’s own formatter config and version apply.'
        )}
      />

      <SearchableSetting
        title={enableLabel}
        description={enableDescription}
        keywords={['format', 'formatter', 'prettier', 'biome', 'gofmt', 'rustfmt', 'save']}
        forceVisible={forceVisible}
      >
        <SettingsSwitchRow
          label={enableLabel}
          description={enableDescription}
          checked={settings.enabled}
          onChange={handleToggle}
        />
        {!hasCommand ? (
          <p className={cn('text-xs', needsCommand ? 'text-destructive' : 'text-muted-foreground')}>
            {translate(
              'auto.components.settings.RepositoryFormatOnSaveSection.needsCommand',
              'Set a formatter command below to turn this on.'
            )}
          </p>
        ) : null}
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.RepositoryFormatOnSaveSection.commandTitle',
          'Formatter Command'
        )}
        description={translate(
          'auto.components.settings.RepositoryFormatOnSaveSection.commandDescription',
          'Shell command run in the worktree root. ${file} and ${relativeFile} expand to the saved file.'
        )}
        keywords={['command', 'formatter', 'prettier', 'oxfmt', 'ruff']}
        forceVisible={forceVisible}
        className="space-y-2 py-2"
      >
        <Label htmlFor="format-on-save-command">
          {translate(
            'auto.components.settings.RepositoryFormatOnSaveSection.commandTitle',
            'Formatter Command'
          )}
        </Label>
        <div
          className={cn(nudging && 'animate-format-on-save-command-nudge')}
          onAnimationEnd={() => setNudging(false)}
        >
          <Input
            id="format-on-save-command"
            ref={commandInputRef}
            value={commandDraft}
            spellCheck={false}
            aria-invalid={needsCommand || undefined}
            placeholder={SUGGESTED_FORMAT_ON_SAVE_COMMAND}
            onChange={(event) => {
              setCommandDraft(event.target.value)
              if (event.target.value.trim().length > 0) {
                setNeedsCommand(false)
              }
            }}
            onBlur={commitCommand}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitCommand()
              }
            }}
            className="font-mono text-xs"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RepositoryFormatOnSaveSection.commandHint',
            'A non-zero exit leaves the saved file untouched and shows the formatter’s error.'
          )}
        </p>
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.RepositoryFormatOnSaveSection.includeTitle',
          'Included Files'
        )}
        description={translate(
          'auto.components.settings.RepositoryFormatOnSaveSection.includeDescription',
          'Comma-separated globs limiting which saved files run the command. Leave empty to format every saved file.'
        )}
        keywords={['glob', 'include', 'files', 'extensions']}
        forceVisible={forceVisible}
        className="space-y-2 py-2"
      >
        <Label htmlFor="format-on-save-include">
          {translate(
            'auto.components.settings.RepositoryFormatOnSaveSection.includeTitle',
            'Included Files'
          )}
        </Label>
        <Input
          id="format-on-save-include"
          value={includeDraft}
          spellCheck={false}
          placeholder={SUGGESTED_FORMAT_ON_SAVE_INCLUDE}
          onChange={(event) => setIncludeDraft(event.target.value)}
          onBlur={commitInclude}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitInclude()
            }
          }}
          className="font-mono text-xs"
        />
      </SearchableSetting>

      {isRuntimeHost ? (
        <p className="max-w-3xl text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RepositoryFormatOnSaveSection.runtimeHostNotice',
            'This project runs on a runtime host, which has no channel for running the command. Saves there are written unformatted; local, WSL, and SSH worktrees are formatted.'
          )}
        </p>
      ) : null}
    </section>
  )
}

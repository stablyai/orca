import { useEffect, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { DEFAULT_CLAUDE_BACKGROUND_SHELL_IGNORE_PATTERNS } from '../../../../shared/claude-background-shell-patterns'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { getExperimentalSearchEntry } from './experimental-search'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'

type BackgroundShellStatusExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

function toPatternList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export function BackgroundShellStatusExperimentalSetting({
  settings,
  updateSettings
}: BackgroundShellStatusExperimentalSettingProps): React.JSX.Element {
  const entry = getExperimentalSearchEntry().backgroundShellStatus
  const enabled = settings.agentStatusIgnoresBackgroundShells === true
  const patterns =
    settings.agentStatusBackgroundShellIgnorePatterns ??
    DEFAULT_CLAUDE_BACKGROUND_SHELL_IGNORE_PATTERNS
  // Why: edit as raw text so a half-typed line isn't split into patterns on every keystroke; commit on blur.
  const [draft, setDraft] = useState(() => patterns.join('\n'))
  const savedText = patterns.join('\n')
  useEffect(() => {
    setDraft(savedText)
  }, [savedText])

  const commitDraft = (): void => {
    const next = toPatternList(draft)
    if (next.join('\n') !== savedText) {
      updateSettings({ agentStatusBackgroundShellIgnorePatterns: next })
    }
  }

  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="space-y-3 py-2"
      id="experimental-background-shell-status"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>{entry.title}</Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ExperimentalPane.backgroundShellStatus.copy',
              'A background shell whose command never exits on its own — a dev server, a watcher — no longer keeps the agent marked as working once its turn ends. Anything not listed below still holds it, as do running subagents and scheduled jobs.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={enabled}
          ariaLabel={translate(
            'auto.components.settings.ExperimentalPane.backgroundShellStatus.toggleLabel',
            'Toggle ignore background shells'
          )}
          onChange={() => updateSettings({ agentStatusIgnoresBackgroundShells: !enabled })}
        />
      </div>
      {enabled ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="background-shell-ignore-patterns">
              {translate(
                'auto.components.settings.ExperimentalPane.backgroundShellStatus.patternsLabel',
                'Never-ending commands'
              )}
            </Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                updateSettings({
                  agentStatusBackgroundShellIgnorePatterns: [
                    ...DEFAULT_CLAUDE_BACKGROUND_SHELL_IGNORE_PATTERNS
                  ]
                })
              }
            >
              {translate(
                'auto.components.settings.ExperimentalPane.backgroundShellStatus.restoreDefaults',
                'Restore defaults'
              )}
            </Button>
          </div>
          <textarea
            id="background-shell-ignore-patterns"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitDraft}
            rows={6}
            spellCheck={false}
            className="w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ExperimentalPane.backgroundShellStatus.patternsHelp',
              'One per line. Each matches a whole word in the command, so "dev" matches "npm run dev" but not "dev-check.sh". A test or build command you leave off this list keeps holding the turn.'
            )}
          </p>
        </div>
      ) : null}
    </SearchableSetting>
  )
}

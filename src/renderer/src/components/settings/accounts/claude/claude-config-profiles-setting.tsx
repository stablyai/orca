import { useState } from 'react'
import { FolderOpen, Plus, Trash2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import {
  CLAUDE_CONFIG_PROFILES_MAX,
  findClaudeConfigProfileByDir,
  isClaudeConfigProfileDir
} from '../../../../../../shared/claude-config-profiles'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { Label } from '../../../ui/label'
import { SearchableSetting } from '../../section-layout/SearchableSetting'

function draftError(
  label: string,
  configDir: string,
  profiles: GlobalSettings['claudeConfigProfiles']
): string | null {
  if (!label.trim()) {
    return translate('accounts.claude.configProfiles.labelRequired', 'Enter a label.')
  }
  if (!isClaudeConfigProfileDir(configDir.trim())) {
    return translate(
      'accounts.claude.configProfiles.pathInvalid',
      'Enter the folder as an absolute path, without ~ or ..'
    )
  }
  if (findClaudeConfigProfileByDir(profiles, configDir)) {
    return translate(
      'accounts.claude.configProfiles.pathDuplicate',
      'This folder is already a profile.'
    )
  }
  return null
}

/** User-owned CLAUDE_CONFIG_DIR folders; removing one only forgets it, the folder stays. */
export function ClaudeConfigProfilesSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const profiles = settings.claudeConfigProfiles ?? []
  const [label, setLabel] = useState('')
  const [configDir, setConfigDir] = useState('')
  const [error, setError] = useState<string | null>(null)
  const title = translate('accounts.claude.configProfiles.title', 'Claude Profiles')
  const description = translate(
    'accounts.claude.configProfiles.description',
    'Start Claude with a config folder of your own (CLAUDE_CONFIG_DIR) and its settings, CLAUDE.md, memory, skills and login. Each profile is its own entry in the agent menu and ignores the account selected above. Orca adds only its status hooks to the folder.'
  )
  const full = profiles.length >= CLAUDE_CONFIG_PROFILES_MAX

  const add = (): void => {
    const problem = draftError(label, configDir, profiles)
    setError(problem)
    if (problem) {
      return
    }
    updateSettings({
      claudeConfigProfiles: [
        ...profiles,
        { id: createBrowserUuid(), label: label.trim(), configDir: configDir.trim() }
      ]
    })
    setLabel('')
    setConfigDir('')
  }

  const browse = async (): Promise<void> => {
    try {
      const picked = await window.api.shell.pickDirectory({})
      if (picked) {
        setConfigDir(picked)
        setError(null)
      }
    } catch (pickError) {
      console.warn('[claude-profiles] Folder picker failed:', pickError)
    }
  }

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['claude', 'profile', 'config', 'folder', 'CLAUDE_CONFIG_DIR', 'settings']}
      className="space-y-3 py-2"
    >
      <div className="space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="space-y-2">
        {profiles.length === 0 ? (
          <div className="rounded-md border border-dashed border-border/70 px-3 py-4 text-xs text-muted-foreground">
            {translate(
              'accounts.claude.configProfiles.empty',
              'No profiles. Add a folder to launch Claude with it.'
            )}
          </div>
        ) : (
          profiles.map((profile) => (
            <div
              key={profile.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2.5"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium">{profile.label}</span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {profile.configDir}
                </span>
              </div>
              <Button
                variant="ghost"
                size="xs"
                title={translate(
                  'accounts.claude.configProfiles.removeHint',
                  'Forget this profile. The folder and its contents stay.'
                )}
                onClick={() =>
                  updateSettings({
                    claudeConfigProfiles: profiles.filter(
                      (candidate) => candidate.id !== profile.id
                    )
                  })
                }
              >
                <Trash2 className="size-3" />
                {translate('auto.components.settings.AccountsPane.db209ee572', 'Remove')}
              </Button>
            </div>
          ))
        )}
      </div>
      <div className="flex items-center gap-2 max-md:flex-wrap">
        <Input
          density="compact"
          value={label}
          maxLength={64}
          aria-label={translate('accounts.claude.configProfiles.labelField', 'Profile label')}
          placeholder={translate('accounts.claude.configProfiles.labelPlaceholder', 'Label')}
          onChange={(event) => setLabel(event.target.value)}
          className="w-32 shrink-0"
        />
        <Input
          density="compact"
          variant="code"
          value={configDir}
          aria-label={translate('accounts.claude.configProfiles.pathField', 'Profile folder')}
          placeholder={translate(
            'accounts.claude.configProfiles.pathPlaceholder',
            'Absolute folder path'
          )}
          onChange={(event) => setConfigDir(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !isImeCompositionKeyDown(event)) {
              add()
            }
          }}
          className="min-w-0 flex-1"
        />
        <Button variant="outline" size="xs" onClick={() => void browse()}>
          <FolderOpen className="size-3" />
          {translate('accounts.claude.configProfiles.browse', 'Browse')}
        </Button>
        <Button variant="outline" size="xs" onClick={add} disabled={full}>
          <Plus className="size-3" />
          {translate('accounts.claude.configProfiles.add', 'Add Profile')}
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </SearchableSetting>
  )
}

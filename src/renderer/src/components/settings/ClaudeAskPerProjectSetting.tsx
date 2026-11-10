import { useTranslate } from '@/i18n/use-translate'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { SearchableSetting } from './section-layout/SearchableSetting'
import { getAskClaudeAccountPerProjectSearchKeywords } from './accounts/accounts-claude-search'

export function ClaudeAskPerProjectSetting({
  settings,
  updateSettings
}: {
  settings: Pick<GlobalSettings, 'askClaudeAccountPerProject'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <SearchableSetting
      title={t(
        'auto.components.settings.AccountsPane.askClaudeAccountPerProjectTitle',
        'Ask which Claude account to use for each project'
      )}
      description={t(
        'auto.components.settings.AccountsPane.askClaudeAccountPerProjectDescription',
        'When on, projects without a saved Claude account ask before starting Claude.'
      )}
      keywords={getAskClaudeAccountPerProjectSearchKeywords()}
      className="space-y-3 py-2"
      id="accounts-claude-ask-per-project"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-1.5">
          <Label>
            {t(
              'auto.components.settings.AccountsPane.askClaudeAccountPerProjectTitle',
              'Ask which Claude account to use for each project'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.AccountsPane.askClaudeAccountPerProjectDescription',
              'When on, projects without a saved Claude account ask before starting Claude.'
            )}
          </p>
        </div>
        <Switch
          aria-label={t(
            'auto.components.settings.AccountsPane.askClaudeAccountPerProjectTitle',
            'Ask which Claude account to use for each project'
          )}
          checked={settings.askClaudeAccountPerProject ?? false}
          onCheckedChange={(checked) => {
            updateSettings({ askClaudeAccountPerProject: checked })
          }}
        />
      </div>
    </SearchableSetting>
  )
}

import { translate } from '../../../../i18n/i18n'
import type { Translate } from '../../../../i18n/use-translate'
import { Button } from '../../../ui/button'
import { Label } from '../../../ui/label'
import { OpenCodeGoIcon } from '../../../status-bar/icons'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { DebouncedSettingsTextInput } from '../../form-controls/DebouncedSettingsTextInput'
import type { AccountsPaneSectionModel } from '../accounts-pane-types'
import { OpenCodeGoCredentials } from '../usage/accounts-pane-opencode-credentials'

export function renderOpenCodeAccountsSection(
  model: AccountsPaneSectionModel,
  t: Translate = translate
): React.JSX.Element {
  const { recordFeatureInteraction, recordOpenCodeSettingEdit, settings, updateSettings } = model
  return (
    <div key="opencode-go" id="accounts-opencode-go" className="scroll-mt-6">
      <SettingsGroup
        title={
          <span className="flex items-center gap-2">
            <OpenCodeGoIcon size={16} />
            {t('auto.components.settings.AccountsPane.4ac10b4d08', 'OpenCode Go')}
          </span>
        }
        description={t(
          'auto.components.settings.AccountsPane.ea631977b5',
          'Configure OpenCode Go provider settings.'
        )}
      >
        <OpenCodeGoCredentials onSaved={() => recordOpenCodeSettingEdit('apiKey')} />

        <SearchableSetting
          title={t(
            'auto.components.settings.AccountsPane.36223200ac',
            'OpenCode Go Session Cookie'
          )}
          description={t(
            'auto.components.settings.AccountsPane.0335bd31d5',
            'Paste the full opencode.ai Cookie header, including __Host-console_session, for rate limit fetching.'
          )}
          keywords={['opencode', 'cookie', 'session', 'console', 'rate limit', 'status bar']}
          className="space-y-2 py-3"
        >
          <Label>
            {t('auto.components.settings.AccountsPane.67e3c33670', 'OpenCode Go session cookie')}
          </Label>
          <div className="flex gap-2">
            <DebouncedSettingsTextInput
              type="password"
              value={settings.opencodeSessionCookie}
              onEdit={() => recordOpenCodeSettingEdit('cookie')}
              commit={(opencodeSessionCookie) => updateSettings({ opencodeSessionCookie })}
              placeholder={t(
                'auto.components.settings.AccountsPane.37b4b4a3f7',
                'auth=…; __Host-console_session=…'
              )}
              spellCheck={false}
              className="flex-1 text-xs"
            />
            {settings.opencodeSessionCookie && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  recordFeatureInteraction('usage-tracking')
                  updateSettings({ opencodeSessionCookie: '' })
                }}
                className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
              >
                {t('auto.components.settings.AccountsPane.b398b834c9', 'Clear')}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.AccountsPane.62ab430f94',
              "Paste the full Cookie header from your browser's DevTools → Network → any opencode.ai request, including __Host-console_session (e.g."
            )}{' '}
            <code className="text-xs">
              {t(
                'auto.components.settings.AccountsPane.37b4b4a3f7',
                'auth=…; __Host-console_session=…'
              )}
            </code>
            {t(
              'auto.components.settings.AccountsPane.d5267cce63',
              '). The auth cookie still covers workspace discovery; auth alone is not enough for usage. OpenCode Go auth is web-based and shared across Windows and WSL terminals.'
            )}
          </p>
        </SearchableSetting>

        <SearchableSetting
          title={t('auto.components.settings.AccountsPane.02cb127710', 'OpenCode Go Workspace ID')}
          description={t(
            'auto.components.settings.AccountsPane.d70a5287a4',
            'Optional workspace ID override if the automatic lookup fails.'
          )}
          keywords={['opencode', 'workspace', 'id', 'wrk', 'rate limit', 'status bar']}
          className="space-y-2 py-3"
        >
          <Label>
            {t('auto.components.settings.AccountsPane.dbdb0b0bd8', 'Workspace ID override')}
          </Label>
          <div className="flex gap-2">
            <DebouncedSettingsTextInput
              type="text"
              value={settings.opencodeWorkspaceId}
              onEdit={() => recordOpenCodeSettingEdit('workspaceId')}
              commit={(opencodeWorkspaceId) => updateSettings({ opencodeWorkspaceId })}
              placeholder={t(
                'auto.components.settings.AccountsPane.a122332371',
                'wrk_… (leave blank for automatic lookup)'
              )}
              spellCheck={false}
              className="flex-1 text-xs"
            />
            {settings.opencodeWorkspaceId && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  recordFeatureInteraction('usage-tracking')
                  updateSettings({ opencodeWorkspaceId: '' })
                }}
                className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
              >
                {t('auto.components.settings.AccountsPane.b398b834c9', 'Clear')}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.AccountsPane.51c9104e13',
              'Find this in the URL after logging into opencode.ai (e.g.'
            )}{' '}
            <code className="text-xs">
              {t(
                'auto.components.settings.AccountsPane.ae3b21eb6c',
                'opencode.ai/workspace/wrk_…/go'
              )}
            </code>
            ).
          </p>
        </SearchableSetting>
      </SettingsGroup>
    </div>
  )
}

import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { GeminiIcon, OpenCodeGoIcon } from '../status-bar/icons'
import { SearchableSetting } from './SearchableSetting'
import type { AccountsPaneSectionModel } from './accounts-pane-types'

export function renderGeminiAccountsSection(model: AccountsPaneSectionModel): React.JSX.Element {
  const { localAccountRuntimeSentenceLabel, recordFeatureInteraction, settings, updateSettings } =
    model
  return (
    <section key="gemini" id="accounts-gemini" className="space-y-4 scroll-mt-6">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <GeminiIcon size={16} />
          {translate('auto.components.settings.AccountsPane.0c64dc2a64', 'Gemini')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.AccountsPane.973741a871',
            'Configure Gemini provider settings.'
          )}
        </p>
      </div>

      <SearchableSetting
        title={translate(
          'auto.components.settings.AccountsPane.0c7f915b01',
          'Use Gemini CLI credentials'
        )}
        description={translate(
          'auto.components.settings.AccountsPane.d676c41fc6',
          'Extracts OAuth credentials from your local Gemini CLI installation to authenticate with Google. This uses credentials issued to the Gemini CLI app, not Orca. May break if Google updates the CLI. Use at your own risk.'
        )}
        keywords={[
          'gemini',
          'cli',
          'oauth',
          'credentials',
          'experimental',
          'rate limit',
          'status bar'
        ]}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.AccountsPane.96f3649526',
              'Use Gemini CLI credentials (experimental)'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.AccountsPane.c2aee76420',
              'Extracts OAuth credentials from your local Gemini CLI installation to authenticate with Google for {{value0}}. This uses credentials issued to the Gemini CLI app, not Orca. May break if Google updates the CLI. Use at your own risk.',
              { value0: localAccountRuntimeSentenceLabel }
            )}
          </p>
        </div>
        <Switch
          aria-label={translate(
            'auto.components.settings.AccountsPane.96f3649526',
            'Use Gemini CLI credentials (experimental)'
          )}
          checked={settings.geminiCliOAuthEnabled}
          onCheckedChange={(checked) => {
            recordFeatureInteraction('usage-tracking')
            updateSettings({
              geminiCliOAuthEnabled: checked
            })
          }}
        />
      </SearchableSetting>
    </section>
  )
}

export function renderOpenCodeAccountsSection(model: AccountsPaneSectionModel): React.JSX.Element {
  const { recordFeatureInteraction, recordOpenCodeSettingEdit, settings, updateSettings } = model
  return (
    <section key="opencode-go" id="accounts-opencode-go" className="space-y-4 scroll-mt-6">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <OpenCodeGoIcon size={16} />
          {translate('auto.components.settings.AccountsPane.4ac10b4d08', 'OpenCode Go')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.AccountsPane.ea631977b5',
            'Configure OpenCode Go provider settings.'
          )}
        </p>
      </div>

      <SearchableSetting
        title={translate(
          'auto.components.settings.AccountsPane.36223200ac',
          'OpenCode Go Session Cookie'
        )}
        description={translate(
          'auto.components.settings.AccountsPane.b2b1aa936d',
          'Paste your opencode.ai session cookie for rate limit fetching.'
        )}
        keywords={['opencode', 'cookie', 'session', 'rate limit', 'status bar']}
        className="space-y-2"
      >
        <Label>
          {translate(
            'auto.components.settings.AccountsPane.67e3c33670',
            'OpenCode Go session cookie'
          )}
        </Label>
        <div className="flex gap-2">
          <Input
            type="password"
            value={settings.opencodeSessionCookie}
            onChange={(e) => {
              recordOpenCodeSettingEdit('cookie')
              updateSettings({ opencodeSessionCookie: e.target.value })
            }}
            placeholder={translate(
              'auto.components.settings.AccountsPane.a7e38affcd',
              'Fe26.2**… token or auth=Fe26.2**… header'
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
              {translate('auto.components.settings.AccountsPane.b398b834c9', 'Clear')}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.AccountsPane.0023cc336e',
            'Paste either the raw token value (e.g.'
          )}{' '}
          <code className="text-xs">
            {translate('auto.components.settings.AccountsPane.922b51e02d', 'Fe26.2**…')}
          </code>
          {translate(
            'auto.components.settings.AccountsPane.338820326a',
            ') or the full cookie header (e.g.'
          )}{' '}
          <code className="text-xs">
            {translate('auto.components.settings.AccountsPane.8951c5309f', 'auth=Fe26.2**…')}
          </code>
          {translate(
            'auto.components.settings.AccountsPane.7ce0e1907c',
            "). Find it in your browser's DevTools → Network → any opencode.ai request → Cookie header. OpenCode Go auth is web-based and shared across Windows and WSL terminals."
          )}
        </p>
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.AccountsPane.02cb127710',
          'OpenCode Go Workspace ID'
        )}
        description={translate(
          'auto.components.settings.AccountsPane.d70a5287a4',
          'Optional workspace ID override if the automatic lookup fails.'
        )}
        keywords={['opencode', 'workspace', 'id', 'wrk', 'rate limit', 'status bar']}
        className="space-y-2"
      >
        <Label>
          {translate('auto.components.settings.AccountsPane.dbdb0b0bd8', 'Workspace ID override')}
        </Label>
        <div className="flex gap-2">
          <Input
            type="text"
            value={settings.opencodeWorkspaceId}
            onChange={(e) => {
              recordOpenCodeSettingEdit('workspaceId')
              updateSettings({ opencodeWorkspaceId: e.target.value })
            }}
            placeholder={translate(
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
              {translate('auto.components.settings.AccountsPane.b398b834c9', 'Clear')}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.AccountsPane.51c9104e13',
            'Find this in the URL after logging into opencode.ai (e.g.'
          )}{' '}
          <code className="text-xs">
            {translate(
              'auto.components.settings.AccountsPane.ae3b21eb6c',
              'opencode.ai/workspace/wrk_…/go'
            )}
          </code>
          ).
        </p>
      </SearchableSetting>
    </section>
  )
}

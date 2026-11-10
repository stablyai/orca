import { useEffect, useState } from 'react'
import type {
  BrowserIdentityModeStatus,
  BrowserUserAgentMode
} from '../../../../../shared/browser-user-agent-mode'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../../shared/execution-host'
import { BROWSER_USER_AGENT_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'
import { useTranslate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from '../form-controls/SettingsFormControls'

type BrowserUserAgentSettingProps = {
  hostId: ExecutionHostId
}

export function BrowserUserAgentSetting({
  hostId
}: BrowserUserAgentSettingProps): React.JSX.Element {
  const t = useTranslate()
  const [status, setStatus] = useState<BrowserIdentityModeStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const title = t('settings.browser.userAgent.title', 'Browser identity')
  const description = t(
    'settings.browser.userAgent.description',
    'Choose the user agent for every browser profile and page. Changes take effect after a restart.'
  )
  const isLocal = hostId === LOCAL_EXECUTION_HOST_ID

  useEffect(() => {
    setStatus(null)
    setError(null)
    if (!isLocal) {
      return
    }
    let disposed = false
    void window.api.browser
      .identityGet()
      .then((nextStatus) => {
        if (!disposed) {
          setStatus(nextStatus)
        }
      })
      .catch((reason) => {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      })
    return () => {
      disposed = true
    }
  }, [isLocal])

  const setMode = (mode: BrowserUserAgentMode): void => {
    setSaving(true)
    setError(null)
    void window.api.browser
      .identitySet(mode)
      .then((result) => {
        if (!result) {
          setError(t('settings.browser.userAgent.unavailable', 'Browser identity is unavailable.'))
        } else if (!result.ok) {
          setError(result.error.message)
        } else {
          setStatus({ identity: result.identity, migrationNotice: null })
        }
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setSaving(false))
  }

  let control: React.JSX.Element
  if (!isLocal) {
    control = (
      <span className="text-xs text-muted-foreground">
        {t(
          'settings.browser.userAgent.remoteUnsupported',
          'Manage browser identity on the remote host with the Orca CLI.'
        )}
      </span>
    )
  } else if (!status) {
    control = (
      <span className="text-xs text-muted-foreground">
        {error ?? t('settings.browser.userAgent.loading', 'Loading…')}
      </span>
    )
  } else if (status.identity.configuredMode === null) {
    // Name the CLI escape: UI reset could overwrite newer Orca data, but refusal still needs an actionable recovery route.
    control = (
      <div className="space-y-1 text-right">
        <div className="text-xs text-destructive">
          {t(
            'settings.browser.userAgent.resetRequired',
            'Identity data must be reset explicitly before it can be changed.'
          )}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {t(
            'settings.browser.userAgent.resetRequiredCommand',
            'Reset it from the command line: orca browser identity set --mode <mode> --reset'
          )}
        </div>
      </div>
    )
  } else {
    control = (
      <div className="space-y-1 text-right">
        <SettingsSegmentedControl<BrowserUserAgentMode>
          size="sm"
          ariaLabel={title}
          value={status.identity.configuredMode}
          onChange={setMode}
          options={[
            {
              value: 'clean',
              disabled: saving,
              label: t('settings.browser.userAgent.optionClean', 'Cleaned'),
              tooltip: t(
                'settings.browser.userAgent.optionCleanTooltip',
                'Removes Orca and Electron tokens to match imported Chrome sessions.'
              )
            },
            {
              value: 'native',
              disabled: saving,
              label: t('settings.browser.userAgent.optionNative', 'Native'),
              tooltip: t(
                'settings.browser.userAgent.optionNativeTooltip',
                "Keeps Electron's built-in identity for sites that reject the cleaned identity."
              )
            }
          ]}
        />
        {status.identity.restartRequired ? (
          <div className="text-[11px] text-muted-foreground">
            {t('settings.browser.userAgent.restartRequired', 'Restart required')}
          </div>
        ) : null}
        {error ? <div className="text-[11px] text-destructive">{error}</div> : null}
      </div>
    )
  }

  return (
    <SearchableSetting
      id={BROWSER_USER_AGENT_SETTINGS_TARGET_ID}
      title={title}
      description={description}
      keywords={['browser', 'identity', 'user agent', 'native', 'cleaned', 'restart']}
    >
      <SettingsRow label={title} description={description} control={control} />
    </SearchableSetting>
  )
}

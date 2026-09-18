import { useEffect, useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { AccountsPaneSectionModel } from './accounts-pane-types'
import { SettingsRow, SettingsSwitch } from './SettingsFormControls'

export function CodexAccountAutomationSettings({
  model
}: {
  model: AccountsPaneSectionModel
}): React.JSX.Element {
  const { settings, updateSettings, isRemoteAccountScope, codexAccounts } = model
  const statusLabels = {
    waiting: translate('settings.codexAutomation.waiting', 'Waiting for reset'),
    deferred: translate(
      'settings.codexAutomation.deferred',
      'Waiting for available quota or an idle account'
    ),
    attempting: translate('settings.codexAutomation.attempting', 'Sending warmup'),
    unconfirmed: translate(
      'settings.codexAutomation.unconfirmed',
      'Activation unconfirmed; no automatic retry'
    ),
    verified: translate('settings.codexAutomation.verified', 'Fresh window observed'),
    unavailable: translate(
      'settings.codexAutomation.unavailable',
      'Warmup unavailable; check account and model support'
    )
  }
  const [liveAccounts, setLiveAccounts] = useState(codexAccounts)
  useEffect(() => {
    setLiveAccounts(codexAccounts)
  }, [codexAccounts])
  useEffect(() => {
    if (isRemoteAccountScope || (!settings.codexAutomaticFailover && !settings.codexResetWarming)) {
      return
    }
    let cancelled = false
    let pending = false
    const timer = setInterval(() => {
      if (pending) {
        return
      }
      pending = true
      void window.api.codexAccounts
        .list()
        .then((state) => {
          if (!cancelled) {
            setLiveAccounts(state)
          }
        })
        .catch(() => {})
        .finally(() => {
          pending = false
        })
    }, 5_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [isRemoteAccountScope, settings.codexAutomaticFailover, settings.codexResetWarming])
  if (isRemoteAccountScope) {
    return (
      <p className="text-xs text-muted-foreground">
        {translate(
          'settings.codexAutomation.remote',
          'Configure account automation on the device that owns these accounts.'
        )}
      </p>
    )
  }
  return (
    <div className="space-y-2">
      <SettingsRow
        label={translate(
          'settings.codexAutomation.failover',
          'Automatically switch accounts when usage limits are reached'
        )}
        description={translate(
          'settings.codexAutomation.failoverDescription',
          'Switch supported native chats to another available account. Terminal sessions and chats using database history require manual recovery.'
        )}
        control={
          <SettingsSwitch
            ariaLabel={translate(
              'settings.codexAutomation.failover',
              'Automatically switch accounts when usage limits are reached'
            )}
            checked={settings.codexAutomaticFailover === true}
            disabled={isRemoteAccountScope}
            onChange={() =>
              updateSettings({ codexAutomaticFailover: !settings.codexAutomaticFailover })
            }
          />
        }
      />
      {settings.codexAutomaticFailover && (
        <SettingsRow
          label={translate(
            'settings.codexAutomation.seamless',
            'Continue automatically after switching'
          )}
          description={translate(
            'settings.codexAutomation.seamlessDescription',
            'Send a continuation in the same conversation after the failed turn settles. Unconfirmed requests and ongoing tools or approvals stay paused.'
          )}
          control={
            <SettingsSwitch
              ariaLabel={translate(
                'settings.codexAutomation.seamless',
                'Continue automatically after switching'
              )}
              checked={settings.codexSeamlessFailover === true}
              disabled={isRemoteAccountScope}
              onChange={() =>
                updateSettings({ codexSeamlessFailover: !settings.codexSeamlessFailover })
              }
            />
          }
        />
      )}
      <SettingsRow
        label={translate(
          'settings.codexAutomation.warming',
          'Activate fresh usage windows after reset'
        )}
        description={translate(
          'settings.codexAutomation.warmingDescription',
          'Send a small inference on each available account using its cheapest known supported model and lowest effort. Uses quota while Orca is open; waits while an account has a running session.'
        )}
        control={
          <SettingsSwitch
            ariaLabel={translate(
              'settings.codexAutomation.warming',
              'Activate fresh usage windows after reset'
            )}
            checked={settings.codexResetWarming === true}
            disabled={isRemoteAccountScope}
            onChange={() => updateSettings({ codexResetWarming: !settings.codexResetWarming })}
          />
        }
      />
      {liveAccounts.automation?.failure && (
        <p className="text-xs text-destructive">{liveAccounts.automation.failure}</p>
      )}
      {settings.codexResetWarming &&
        liveAccounts.accounts.map((account) => {
          const status = liveAccounts.automation?.warming[account.id]
          return status ? (
            <p key={account.id} className="text-xs text-muted-foreground">
              {account.email}: {statusLabels[status.status]}
              {status.nextResetAt ? ` · ${new Date(status.nextResetAt).toLocaleString()}` : ''}
            </p>
          ) : null
        })}
    </div>
  )
}

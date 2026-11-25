import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '../../../../store/index'
import { Badge } from '../../../ui/badge'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { Label } from '../../../ui/label'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import type { CommandCodeCredentialsStatus } from '../../../../../../shared/agent-accounts/usage-credentials/command-code-credentials'

type CredentialStatus = boolean | 'loading' | 'unavailable'

/** Kept out of the component: the React compiler cannot lower try/finally. */
async function changeCommandCodeKey(
  clear: boolean,
  key: string
): Promise<CommandCodeCredentialsStatus | null> {
  try {
    return clear
      ? await window.api.commandCodeCredentials.clearApiKey()
      : await window.api.commandCodeCredentials.saveApiKey(key)
  } catch {
    return null
  }
}

/** Local-only: the key is saved on this device and never leaves main. Switching accounts means replacing the key. */
export function CommandCodeAccountsSection(): React.JSX.Element {
  const t = useTranslate()
  const usage = useAppStore((s) => s.rateLimits.commandCode)
  const [draft, setDraft] = useState('')
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus>('loading')
  const [busy, setBusy] = useState(false)
  const statusReadGeneration = useRef(0)
  const configured = credentialStatus === true

  useEffect(() => {
    let active = true
    const generation = statusReadGeneration.current
    void window.api.commandCodeCredentials.getStatus().then(
      (status: CommandCodeCredentialsStatus) => {
        if (active && generation === statusReadGeneration.current) {
          setCredentialStatus(status.apiKeyConfigured)
        }
      },
      () => {
        if (active && generation === statusReadGeneration.current) {
          setCredentialStatus('unavailable')
        }
        console.error('Failed to load Command Code credential status')
      }
    )
    return () => {
      active = false
    }
  }, [])

  const updateCredential = async (clear: boolean): Promise<void> => {
    setBusy(true)
    const status = await changeCommandCodeKey(clear, draft.trim())
    setBusy(false)
    if (!status) {
      toast.error(t('sessionHistory.settings.saveError', 'Could not save. Try again.'))
      return
    }
    statusReadGeneration.current += 1
    setCredentialStatus(status.apiKeyConfigured)
    setDraft('')
  }

  const monthlyPercent = usage?.monthly ? Math.round(usage.monthly.usedPercent) : null
  const balance = usage?.extraUsage?.unit === 'credits' ? usage.extraUsage.balance : null

  return (
    <SettingsGroup
      id="accounts-command-code"
      title={t('auto.components.settings.AccountsPane.commandCode.title', 'Command Code')}
    >
      <SearchableSetting
        title={t(
          'auto.components.settings.AccountsPane.commandCode.apiKey.title',
          'Command Code API key'
        )}
        description={t(
          'auto.components.settings.AccountsPane.commandCode.apiKey.description',
          'Save a Command Code API key to see plan usage and credits for it below.'
        )}
        keywords={['command code', 'commandcode', 'api', 'key', 'usage', 'rate limit', 'credits']}
        className="space-y-2 py-3"
      >
        <div className="flex items-center gap-2">
          <Label htmlFor="command-code-api-key">
            {t('auto.components.settings.AccountsPane.commandCode.apiKey.label', 'API key')}
          </Label>
          <Badge variant={configured ? 'secondary' : 'outline'}>
            {credentialStatus === 'loading'
              ? t('auto.components.settings.AccountsPane.commandCode.checking', 'Checking…')
              : credentialStatus === 'unavailable'
                ? t(
                    'auto.components.settings.AccountsPane.commandCode.unavailable',
                    'Status unavailable'
                  )
                : configured
                  ? t('auto.components.settings.AccountsPane.73ea15f24b', 'Saved')
                  : t('auto.components.settings.AccountsPane.23afe8f226', 'Not saved')}
          </Badge>
        </div>
        <div className="flex gap-2">
          <Input
            id="command-code-api-key"
            type="password"
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t(
              'auto.components.settings.AccountsPane.commandCode.apiKey.placeholder',
              'Paste your Command Code API key'
            )}
            spellCheck={false}
            className="flex-1"
          />
          <Button
            size="xs"
            disabled={busy || !draft.trim()}
            onClick={() => void updateCredential(false)}
          >
            {configured
              ? t('auto.components.settings.AccountsPane.f38b9cc4bd', 'Replace')
              : t('auto.components.settings.AccountsPane.590a3130f9', 'Save')}
          </Button>
          {configured && (
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => void updateCredential(true)}
            >
              {t('auto.components.settings.AccountsPane.b398b834c9', 'Clear')}
            </Button>
          )}
        </div>
      </SearchableSetting>
      {configured && usage && (
        <div className="space-y-1 py-3 text-sm text-muted-foreground">
          {monthlyPercent !== null && (
            <p>
              {t(
                'auto.components.settings.AccountsPane.commandCode.monthly',
                'Monthly plan: {{percent}}% used',
                {
                  percent: monthlyPercent
                }
              )}
            </p>
          )}
          {usage.planType && (
            <p>
              {t('auto.components.settings.AccountsPane.commandCode.plan', 'Plan: {{plan}}', {
                plan: usage.planType
              })}
            </p>
          )}
          {balance !== null && (
            <p>
              {t(
                'auto.components.settings.AccountsPane.commandCode.credits',
                'Credits remaining: {{credits}}',
                {
                  credits: balance
                }
              )}
            </p>
          )}
          {usage.error && <p className="text-destructive">{usage.error}</p>}
        </div>
      )}
    </SettingsGroup>
  )
}

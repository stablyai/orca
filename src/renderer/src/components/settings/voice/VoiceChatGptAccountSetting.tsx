import { useEffect, useId, useRef, useState } from 'react'
import type { ChatGptSpeechAccount, VoiceSettings } from '../../../../../shared/speech/speech-types'
import { readIpcErrorMessage } from '@/runtime/errors/ipc-error'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { Button } from '../../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SettingsRow } from '../form-controls/SettingsFormControls'

export function VoiceChatGptAccountSetting({
  accountId,
  accounts,
  loading = false,
  error,
  onChange,
  disabled = false,
  onManage
}: {
  accountId: string | null | undefined
  accounts: ChatGptSpeechAccount[]
  loading?: boolean
  error?: string | null
  disabled?: boolean
  onChange: (id: string | null) => void
  onManage: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const labelId = useId()
  const unavailable = !!accountId && !accounts.some((account) => account.id === accountId)
  const unavailableLabel =
    loading || error
      ? accountId
      : t('settings.voice.chatgptAccountUnavailable', '{{account}} (unavailable)', {
          account: accountId ?? ''
        })
  return (
    <SettingsRow
      label={t('settings.voice.chatgptAccount', 'ChatGPT account')}
      labelId={labelId}
      description={
        <>
          {error ? (
            <span role="alert">{error} </span>
          ) : loading ? (
            t('settings.voice.chatgptAccountsLoading', 'Loading accounts…')
          ) : (
            t(
              'settings.voice.chatgptAccountDescription',
              'Used only for dictation, independently of your chat account.'
            )
          )}{' '}
          <Button variant="link" size="inline" onClick={onManage}>
            {t('settings.voice.chatgptManageAccounts', 'Manage AI Provider Accounts')}
          </Button>
        </>
      }
      control={
        <Select
          value={accountId ?? 'unconfigured'}
          disabled={loading || disabled}
          onValueChange={(value) => onChange(value === 'unconfigured' ? null : value)}
        >
          <SelectTrigger size="sm" className="w-56" aria-labelledby={labelId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="unconfigured">
              {t('settings.voice.chatgptChooseAccount', 'Choose an account')}
            </SelectItem>
            {unavailable ? (
              <SelectItem value={accountId!} disabled>
                {unavailableLabel}
              </SelectItem>
            ) : null}
            {accounts.map((account) => (
              <SelectItem key={account.id} value={account.id}>
                {account.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  )
}

export function VoiceChatGptAccountSettings({
  voiceSettings,
  onUpdateVoiceSettings
}: {
  voiceSettings: VoiceSettings
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void | Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const [accounts, setAccounts] = useState<ChatGptSpeechAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const generation = { current: 0 }
    const refresh = (): void => {
      const current = ++generation.current
      setLoading(true)
      void window.api.speech
        .getChatGptAccounts()
        .then((nextAccounts) => {
          if (cancelled || current !== generation.current) {
            return
          }
          setAccounts(nextAccounts)
          setError(null)
        })
        .catch((err: unknown) => {
          if (!cancelled && current === generation.current) {
            setError(
              readIpcErrorMessage(err) ??
                t(
                  'settings.voice.chatgptAccountsFailed',
                  'Could not load ChatGPT accounts. Reopen Voice settings to retry.'
                )
            )
          }
        })
        .finally(() => {
          if (!cancelled && current === generation.current) {
            setLoading(false)
          }
        })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      cancelled = true
      window.removeEventListener('focus', refresh)
    }
  }, [t])
  return (
    <VoiceChatGptAccountSetting
      accountId={voiceSettings.chatGptAccountId}
      accounts={accounts}
      loading={loading || pending}
      disabled={!!error}
      error={error ?? saveError}
      onChange={(chatGptAccountId) => {
        if (pendingRef.current) {
          return
        }
        pendingRef.current = true
        setPending(true)
        setSaveError(null)
        void Promise.resolve()
          .then(() => onUpdateVoiceSettings({ chatGptAccountId }))
          .catch((err: unknown) => {
            setSaveError(
              readIpcErrorMessage(err) ??
                t(
                  'settings.voice.chatgptAccountSaveFailed',
                  'Could not update the dictation account. Try again.'
                )
            )
          })
          .finally(() => {
            pendingRef.current = false
            setPending(false)
          })
      }}
      onManage={() =>
        openSettingsTarget({
          pane: 'accounts',
          repoId: null,
          sectionId: 'accounts-codex',
          hostScope: { kind: 'local' },
          intent: 'native-accounts'
        })
      }
    />
  )
}

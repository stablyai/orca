import React, { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import type { FeishuLocalState } from '../../../../../shared/bots/feishu-local'
import { feishuCall, useFeishuState } from './feishu-local-client'

const CREATE_PERSONAL_APP = 'lark-cli config init --new --name <new-name> --brand feishu'

export function BotFeishuSetup({
  bot,
  onClose
}: {
  bot: Bot
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const state = useFeishuState(bot)
  const [profiles, setProfiles] = useState<string[]>([])
  const [selected, select] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const off = state?.status === 'off'
  useEffect(() => {
    if (!off) {
      return
    }
    let alive = true
    void feishuCall<string[]>(bot, 'profiles', {})
      .then((names) => {
        if (alive) {
          setProfiles(names)
          select((p) => (names.includes(p) ? p : (names[0] ?? '')))
          setError(false)
        }
      })
      .catch(() => {
        if (alive) {
          setError(true)
        }
      })
    return () => {
      alive = false
    }
  }, [bot, off, refresh])
  const change = async (): Promise<void> => {
    setBusy(true)
    setError(false)
    try {
      await feishuCall(
        bot,
        off ? 'connect' : 'remove',
        off ? { botId: bot.id, profile: selected } : { botId: bot.id }
      )
    } catch {
      setError(true)
    }
    setBusy(false)
  }
  const status = (s: FeishuLocalState['status']): string => {
    switch (s) {
      case 'off':
        return t(
          'bots.feishu.choose',
          'Choose a Feishu CLI profile on the computer that runs this bot.'
        )
      case 'connecting':
        return t('bots.feishu.connecting', 'Starting the Feishu listener…')
      case 'verification-failed':
        return t(
          'bots.feishu.verificationFailed',
          'Could not verify the original DM. Check the app’s permission to read private messages, then send the code again.'
        )
      case 'pairing':
        return t(
          'bots.feishu.pairing',
          'Send this code from your own Feishu account in a direct message to the app. It expires in five minutes.'
        )
      case 'listening':
        return t('bots.feishu.listening', 'Listening for text messages in your verified Feishu DM.')
      case 'retrying':
        return t(
          'bots.feishu.retrying',
          'Retrying. Check the CLI profile, permissions and long-connection subscription on the bot’s computer.'
        )
      case 'paused':
        return t('bots.feishu.paused', 'This bot is paused or disabled.')
      case 'expired':
        return t('bots.feishu.expired', 'Pairing expired. Disconnect and select the profile again.')
      case 'review':
        return t(
          'bots.feishu.review',
          'A delivery could not be confirmed. Check the original DM and the native chat before resending.'
        )
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent surface="security" aria-describedby={undefined}>
        <DialogTitle>{t('bots.feishu.title', 'Feishu on this host')}</DialogTitle>
        <p className="text-sm text-muted-foreground" role="status">
          {state
            ? status(state.status)
            : state === null
              ? t('bots.feishu.hostError', 'Could not read the bot’s host.')
              : t('bots.feishu.loading', 'Checking the host…')}
        </p>
        {off ? (
          <>
            <Label htmlFor="feishu-profile">{t('bots.feishu.profile', 'Feishu CLI profile')}</Label>
            <Select value={selected} onValueChange={select} disabled={!profiles.length || busy}>
              <SelectTrigger id="feishu-profile">
                <SelectValue
                  placeholder={t('bots.feishu.noProfiles', 'No Feishu profile available')}
                />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((p) => (
                  <SelectItem value={p} key={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t(
                'bots.feishu.create',
                'To create a personal app, run the following once on the bot’s computer with a new profile name. Follow the CLI’s browser setup, then refresh.'
              )}
            </p>
            <code className="select-all rounded-md bg-muted p-2 text-xs">
              {CREATE_PERSONAL_APP}
            </code>
            <p className="text-xs text-muted-foreground">
              {t(
                'bots.feishu.scopes',
                'Enable long connections and the Receive message event. Grant permission to read DMs and send messages as the app.'
              )}
            </p>
          </>
        ) : null}
        {state?.pairingText ? (
          <code className="select-all break-all rounded-md bg-muted p-2 text-xs">
            {state.pairingText}
          </code>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {t(
              'bots.feishu.error',
              'Check that lark-cli is installed on this host and the profile is available for this bot.'
            )}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          {off ? (
            <Button variant="ghost" onClick={() => setRefresh((n) => n + 1)}>
              {t('bots.feishu.refresh', 'Refresh profiles')}
            </Button>
          ) : null}
          {state ? (
            <Button
              variant={off ? 'default' : 'outline'}
              disabled={busy || (off && !selected)}
              onClick={() => void change()}
            >
              {off
                ? t('bots.feishu.pair', 'Pair my DM')
                : t('bots.feishu.disconnect', 'Disconnect Feishu')}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

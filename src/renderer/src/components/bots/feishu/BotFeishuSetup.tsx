import React, { useEffect, useState } from 'react'
import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import { botTarget } from '@/lib/bot-hosts'
import { openOwnedHttpLink } from '@/lib/browser/navigation/http-link-routing'
import { BotAppBrandLogo } from '../apps/BotAppBrandLogo'
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
import { FEISHU_CLI_MISSING, type FeishuLocalState } from '../../../../../shared/bots/feishu-local'
import { feishuCall, useFeishuState } from './feishu-local-client'

export function BotFeishuSetup({
  bot,
  onClose
}: {
  bot: Bot
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const state = useFeishuState(bot)
  const [createCommand] = useState(
    () =>
      `lark-cli config init --new --name orca-feishu-${createNonSecureContextUuid().slice(0, 8)} --brand feishu`
  )
  const [cliMissing, setCliMissing] = useState(false)
  const [profiles, setProfiles] = useState<string[]>([])
  const [selected, select] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const target = botTarget(bot)
  const off = state?.status === 'off'
  useEffect(() => {
    if (!off) {
      return
    }
    let alive = true
    void feishuCall<string[]>(bot, 'profiles', {})
      .then((names) => {
        if (alive) {
          setCliMissing(false)
          setProfiles(names)
          select((p) => (names.includes(p) ? p : names.length === 1 ? names[0]! : ''))
          setError(false)
        }
      })
      .catch((cause: unknown) => {
        if (alive) {
          const missing = cause instanceof Error && cause.message.includes(FEISHU_CLI_MISSING)
          setCliMissing(missing)
          setProfiles([])
          select('')
          setError(!missing)
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
      case 'cli-missing':
        if (!off) {
          return t(
            'bots.feishu.installReconnect',
            'Install lark-cli on the computer running this bot. Orca will retry the connection automatically.'
          )
        }
        return t(
          'bots.feishu.cliMissing',
          'Install lark-cli on the computer running this bot, then refresh profiles.'
        )
      case 'permission':
        return t(
          'bots.feishu.permission',
          'Grant the app permission to receive private messages and publish the updated app version. Orca will retry.'
        )
      case 'subscription':
        return t(
          'bots.feishu.subscription',
          'Subscribe to Receive message (im.message.receive_v1) using a long connection and publish the updated app version. Orca will retry.'
        )
      case 'profile-changed':
        return t(
          'bots.feishu.profileChanged',
          'The selected CLI profile no longer resolves to the paired app. Restore it or disconnect to choose another profile.'
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
        return t(
          'bots.feishu.listening',
          'Listening for messages, images and files in your verified Feishu DM.'
        )
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
        <div className="flex items-center gap-2">
          <BotAppBrandLogo app={{ id: 'feishu-local' }} />
          <DialogTitle>{t('bots.feishu.title', 'Feishu on this host')}</DialogTitle>
        </div>
        <p className="text-sm text-muted-foreground" role="status">
          {state
            ? status(off && cliMissing ? 'cli-missing' : state.status)
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
                  placeholder={
                    profiles.length
                      ? t('bots.feishu.selectProfile', 'Choose a profile')
                      : t('bots.feishu.noProfiles', 'No Feishu profile available')
                  }
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
                'To create a PersonalAgent, run this command on the bot’s computer. Finish the CLI’s browser setup, then refresh profiles.'
              )}
            </p>
            <code className="select-all rounded-md bg-muted p-2 text-xs">{createCommand}</code>
            <Button
              size="sm"
              variant="outline"
              className="justify-self-start"
              onClick={() =>
                void window.api.ui.writeClipboardText(createCommand).catch(() => setError(true))
              }
            >
              {t('bots.feishu.copyCommand', 'Copy setup command')}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t(
                'bots.feishu.scopes',
                'Enable long connections and the Receive message event. Allow the app to read DMs, send messages and upload files.'
              )}
            </p>
          </>
        ) : null}
        {state?.pairingText ? (
          <div className="space-y-2">
            <code className="block select-all break-all rounded-md bg-muted p-2 text-xs">
              {state.pairingText}
            </code>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void window.api.ui
                    .writeClipboardText(state.pairingText!)
                    .catch(() => setError(true))
                }
              >
                {t('bots.feishu.copyCode', 'Copy code')}
              </Button>
              {state.appId && /^cli_[a-zA-Z0-9]+$/.test(state.appId) ? (
                <Button
                  size="sm"
                  onClick={() =>
                    openOwnedHttpLink(
                      `https://applink.feishu.cn/client/bot/open?appId=${encodeURIComponent(state.appId!)}`,
                      {
                        sourceOwner:
                          target.kind === 'environment'
                            ? { kind: 'runtime', runtimeEnvironmentId: target.environmentId }
                            : target,
                        forceSystemBrowser: true
                      }
                    )
                  }
                >
                  {t('bots.feishu.openDm', 'Open Feishu DM')}
                </Button>
              ) : null}
            </div>
          </div>
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

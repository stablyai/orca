import React, { useEffect, useState } from 'react'
import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import { botTarget } from '@/lib/bot-hosts'
import { openOwnedHttpLink } from '@/lib/browser/navigation/http-link-routing'
import { BotAppBrandLogo } from '../apps/BotAppBrandLogo'
import { botHostHas } from '@/lib/bot-host-status'
import {
  BOTS_FEISHU_GROUP_CAPABILITY,
  BOTS_FEISHU_SDK_CAPABILITY
} from '../../../../../shared/bot-runtime-capabilities'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Input } from '@/components/ui/input'
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
import { FEISHU_CLI_MISSING, FeishuGroupPolicy } from '../../../../../shared/bots/feishu-local'
import { feishuSetupStatus } from './feishu-setup-status'
import { BotFeishuGroupFields } from './BotFeishuGroupFields'
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
  const sdkAvailable = botHostHas(bot.hostId, BOTS_FEISHU_SDK_CAPABILITY)
  const [method, setMethod] = useState<'sdk' | 'cli'>(sdkAvailable ? 'sdk' : 'cli')
  const [appId, setAppId] = useState('')
  const [secret, setSecret] = useState('')
  const sdk = sdkAvailable && method === 'sdk'
  const groupAvailable = sdk && botHostHas(bot.hostId, BOTS_FEISHU_GROUP_CAPABILITY)
  const [groupChat, setGroupChat] = useState('')
  const [groupMembers, setGroupMembers] = useState('')
  const group =
    groupAvailable && (groupChat.trim() || groupMembers.trim())
      ? FeishuGroupPolicy.safeParse({
          chatId: groupChat.trim(),
          members: [...new Set(groupMembers.split(/[\s,，]+/).filter(Boolean))]
        })
      : null
  const [cliMissing, setCliMissing] = useState(false)
  const [profiles, setProfiles] = useState<string[]>([])
  const [selected, select] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const target = botTarget(bot)
  const off = state?.status === 'off'
  useEffect(() => {
    if (!off || sdk) {
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
  }, [bot, off, refresh, sdk])
  const change = async (): Promise<void> => {
    setBusy(true)
    setError(false)
    try {
      await feishuCall(
        bot,
        off ? 'connect' : 'remove',
        off
          ? sdk
            ? {
                botId: bot.id,
                appId: appId.trim(),
                appSecret: secret,
                ...(group?.success ? { group: group.data } : {})
              }
            : { botId: bot.id, profile: selected }
          : { botId: bot.id }
      )
      setSecret('')
    } catch {
      setError(true)
    }
    setBusy(false)
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
        {off && sdkAvailable ? (
          <RadioGroup
            layout="inline"
            aria-label={t('bots.feishu.method', 'Connection method')}
            value={method}
            disabled={busy}
            onValueChange={(v) => {
              setMethod(v === 'cli' ? 'cli' : 'sdk')
              setError(false)
              setSecret('')
            }}
          >
            <RadioGroupItem value="sdk" variant="pill">
              {t('bots.feishu.credentials', 'App credentials')}
            </RadioGroupItem>
            <RadioGroupItem value="cli" variant="pill">
              {t('bots.feishu.cliMethod', 'Local CLI')}
            </RadioGroupItem>
          </RadioGroup>
        ) : null}
        <p className="text-sm text-muted-foreground" role="status">
          {state
            ? feishuSetupStatus(t, off && !sdk && cliMissing ? 'cli-missing' : state.status, {
                sdk,
                off,
                groupEnabled: Boolean(state.groupChatId)
              })
            : state === null
              ? t('bots.feishu.hostError', 'Could not read the bot’s host.')
              : t('bots.feishu.loading', 'Checking the host…')}
        </p>
        {off && sdk ? (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="feishu-app-id">{t('bots.feishu.appId', 'App ID')}</Label>
              <Input
                id="feishu-app-id"
                autoComplete="off"
                spellCheck={false}
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="feishu-secret">{t('bots.feishu.appSecret', 'App secret')}</Label>
              <Input
                id="feishu-secret"
                type="password"
                autoComplete="off"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                disabled={busy}
              />
            </div>
            {groupAvailable ? (
              <BotFeishuGroupFields
                chatId={groupChat}
                members={groupMembers}
                onChatId={setGroupChat}
                onMembers={setGroupMembers}
                disabled={busy}
                invalid={group?.success === false}
              />
            ) : null}
          </div>
        ) : null}
        {off && !sdk ? (
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
          </>
        ) : null}
        {off ? (
          <p className="text-xs text-muted-foreground">
            {t(
              'bots.feishu.scopes',
              'Enable long connections and the Receive message event. Publish app permissions to read DMs, reply as the bot and upload IM files.'
            )}
          </p>
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
              'Check the selected setup method and confirm this app is available for this bot.'
            )}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          {off && !sdk ? (
            <Button variant="ghost" onClick={() => setRefresh((n) => n + 1)}>
              {t('bots.feishu.refresh', 'Refresh profiles')}
            </Button>
          ) : null}
          {state ? (
            <Button
              variant={off ? 'default' : 'outline'}
              disabled={
                busy ||
                (off &&
                  (sdk
                    ? !/^cli_[a-fA-F0-9]{16}$/.test(appId.trim()) ||
                      !/^[\x21-\x7e]{1,256}$/.test(secret) ||
                      group?.success === false
                    : !selected))
              }
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

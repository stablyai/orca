import React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { SettingsSubsectionHeader } from '@/components/settings/form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostLabel } from '../use-bot-host-label'
import { useHostBots } from '@/lib/bot-catalog'
import { botLinearCalls } from '@/lib/bot-connector-host-calls'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { connectAnotherAccount, useConnectorConnect } from '@/lib/connector-connect-state'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { refreshBotLinear, useBotLinear } from '@/lib/bot-linear-state'
import type { ConnectorLinearWorkspace } from '../../../../../shared/connector-bot-linear-contract'
import { botLinearErrorMessage, linearWorkspaceLabel } from './bot-linear-copy'

// Select items need a non-empty value.
const ASK_EACH_TIME = 'ask'

function DefaultBotPicker({
  hostId,
  workspace
}: {
  hostId: ExecutionHostId
  workspace: ConnectorLinearWorkspace
}): React.JSX.Element {
  const t = useTranslate()
  const hostName = useBotHostLabel(hostId)
  // The host's account, so only its own bots.
  const onLinear = useHostBots(hostId).filter(
    (bot) => bot.linear?.workspaceId === workspace.workspaceId
  )
  const label = t('bots.linear.account.defaultBot', 'Default bot for my requests')
  // The default is the account's, so it may be a bot another of the owner's computers hosts.
  const elsewhere =
    workspace.defaultBotId && !onLinear.some((bot) => bot.id === workspace.defaultBotId)
      ? workspace.defaultBotId
      : null

  const choose = async (value: string): Promise<void> => {
    const result = await botLinearCalls(hostId).setDefaultBot({
      workspaceId: workspace.workspaceId,
      botId: value === ASK_EACH_TIME ? null : value
    })
    if (!result.ok) {
      toast.error(botLinearErrorMessage(result.error, hostName))
    }
    await refreshBotLinear(hostId)
  }

  return (
    <Select value={workspace.defaultBotId ?? ASK_EACH_TIME} onValueChange={(v) => void choose(v)}>
      <SelectTrigger size="sm" aria-label={label} className="min-w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ASK_EACH_TIME}>
          {t('bots.linear.account.askEachTime', 'Ask which bot')}
        </SelectItem>
        {onLinear.map((bot) => (
          <SelectItem key={bot.id} value={bot.id}>
            {bot.name}
          </SelectItem>
        ))}
        {elsewhere ? (
          <SelectItem value={elsewhere}>
            {t('bots.linear.account.otherComputer', 'A bot on another computer')}
          </SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  )
}

/**
 * Settings › Bots › Linear: the Linear accounts a host's Orca account is linked as, and each one's
 * default bot. `hostName` names a paired server; null is this computer.
 */
export function LinearAccountSettings({
  hostId,
  hostName
}: {
  hostId: ExecutionHostId
  hostName: string | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const view = useBotLinear(hostId)
  const connect = useConnectorConnect(hostId, 'linear')

  const unlink = async (workspaceId: string): Promise<void> => {
    const result = await botLinearCalls(hostId).unlink({ workspaceId })
    if (!result.ok) {
      toast.error(botLinearErrorMessage(result.error, hostName))
    }
    await refreshBotLinear(hostId)
  }
  // A wrong user is fixed by signing in again as the right one; its sign-in replaces the link.
  const reconnect = (workspaceId: string): void =>
    void connectAnotherAccount(hostId, 'linear', () =>
      botLinearCalls(hostId).unlink({ workspaceId })
    )

  // Until the cloud has Linear, the Connectors list says "Coming soon".
  if (view.status === 'off' || view.status === 'loading') {
    return null
  }
  const header = (
    <SettingsSubsectionHeader
      title={t('bots.linear.account.title', 'Linear')}
      description={
        hostName
          ? t(
              'bots.linear.account.descriptionOnHost',
              'The Linear user {{host}}’s bots act as and are owned by. {{host}} keeps its sign-in.',
              { host: hostName }
            )
          : t(
              'bots.linear.account.description',
              'Your Linear account in each workspace, so Linear knows your requests are yours.'
            )
      }
    />
  )
  if (view.status === 'failed') {
    return (
      <section className="space-y-3">
        {header}
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            {botLinearErrorMessage(view.error, hostName)}
          </p>
          <Button size="sm" variant="outline" onClick={() => void refreshBotLinear(hostId)}>
            {t('bots.linear.setup.retry', 'Try again')}
          </Button>
        </div>
      </section>
    )
  }
  const { workspaces } = view.linear
  return (
    <section className="space-y-3">
      {header}
      {workspaces.length > 0 ? (
        <div className="divide-y divide-border rounded-md border border-border">
          {workspaces.map((workspace) => (
            <div key={workspace.workspaceId} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {linearWorkspaceLabel(workspace.name, workspace.urlKey)}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {t('bots.linear.account.linkedAs', 'Linked as {{name}}', {
                    name: workspace.userName || workspace.userId
                  })}
                </p>
              </div>
              <DefaultBotPicker hostId={hostId} workspace={workspace} />
              {isPairedWebClientWindow() ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={connect.status === 'waiting'}
                  onClick={() => reconnect(workspace.workspaceId)}
                >
                  {t('bots.linear.account.reconnect', 'Reconnect')}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => void unlink(workspace.workspaceId)}>
                {t('bots.linear.account.unlink', 'Unlink')}
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {connect.status === 'failed' ? (
        <p role="alert" className="text-sm text-destructive">
          {botLinearErrorMessage(connect.error, hostName)}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        {isPairedWebClientWindow()
          ? t(
              'bots.linear.account.linkFromApp',
              'Link Linear from Orca on a computer paired to {{host}}.',
              { host: hostName ?? '' }
            )
          : t(
              'bots.linear.account.linkHelp',
              'To link your Linear account, or move it here from another Orca account, connect Linear from a bot’s Connectors.'
            )}
      </p>
    </section>
  )
}

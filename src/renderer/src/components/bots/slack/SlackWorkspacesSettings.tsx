import React, { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostLabel } from '../use-bot-host-label'
import { SettingsSubsectionHeader } from '@/components/settings/form-controls/SettingsFormControls'
import { useBots, useHostBots } from '@/lib/bot-catalog'
import { botSlackCalls } from '@/lib/bot-connector-host-calls'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { slackTeamState, useBotSlack } from '@/lib/bot-slack-state'
import { botSlackApps, type Bot } from '../../../../../shared/bot-types'
import { botSlackErrorMessage } from './bot-slack-copy'
import { SlackConfigTokenForm } from './SlackConfigTokenForm'

/** The Slack workspaces one computer's bots are in, each with the bots it holds. */
export function slackWorkspaces(bots: readonly Bot[]): { teamId: string; bots: Bot[] }[] {
  const byTeam = new Map<string, Bot[]>()
  for (const bot of bots) {
    for (const { teamId } of botSlackApps(bot)) {
      byTeam.set(teamId, [...(byTeam.get(teamId) ?? []), bot])
    }
  }
  return [...byTeam].map(([teamId, teamBots]) => ({ teamId, bots: teamBots }))
}

/** The workspace as one of its bots' Slack state reports it: its name, and who installed that bot. */
function useSlackTeam(
  bot: Bot | undefined,
  teamId: string
): { name: string; installerName: string | null } {
  const view = useBotSlack(bot ?? null)
  const team = view.status === 'ready' ? slackTeamState(view.slack, teamId) : null
  return team?.state === 'installed'
    ? { name: team.teamName ?? teamId, installerName: team.installerName ?? null }
    : { name: teamId, installerName: null }
}

/** The workspace's name as one of the host's bots' Slack state reports it; its id until then, or if none. */
export function SlackTeamName({
  hostId,
  teamId
}: {
  hostId: ExecutionHostId
  teamId: string
}): React.JSX.Element {
  return <>{useSlackTeamName(hostId, teamId)}</>
}

/** The workspace's name as one of the host's bots there reads it; its id until known. */
export function useSlackTeamName(hostId: ExecutionHostId, teamId: string): string {
  const bot = slackWorkspaces(useHostBots(hostId)).find((workspace) => workspace.teamId === teamId)
    ?.bots[0]
  return useSlackTeam(bot, teamId).name
}

function SlackTeamLabel({
  bot,
  teamId
}: {
  bot: Bot | undefined
  teamId: string
}): React.JSX.Element {
  return <>{useSlackTeam(bot, teamId).name}</>
}

/** One bot in its workspace, and who installed it there, so a wrong Slack user shows. */
function SlackBotInstaller({ bot, teamId }: { bot: Bot; teamId: string }): React.JSX.Element {
  const t = useTranslate()
  const { installerName } = useSlackTeam(bot, teamId)
  return (
    <>
      {installerName
        ? t('bots.slack.workspaces.installedBy', '{{bot}}, installed by @{{user}}', {
            bot: bot.name,
            user: installerName
          })
        : bot.name}
    </>
  )
}

/** "CoS, installed by @x · Docs bot, installed by @y": each bot's own installer, its Slack owner. */
function SlackTeamDetail({ bots, teamId }: { bots: Bot[]; teamId: string }): React.JSX.Element {
  return (
    <>
      {bots.map((bot, index) => (
        <React.Fragment key={bot.id}>
          {index > 0 ? ' · ' : null}
          <SlackBotInstaller bot={bot} teamId={teamId} />
        </React.Fragment>
      ))}
    </>
  )
}

function ReconnectDialog({
  hostId,
  teamId,
  onOpenChange
}: {
  hostId: ExecutionHostId
  teamId: string | null
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const hostName = useBotHostLabel(hostId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (refreshToken: string): Promise<void> => {
    setBusy(true)
    setError(null)
    const grant = await botSlackCalls(hostId).saveGrant({ refreshToken })
    setBusy(false)
    if (!grant.ok) {
      setError(botSlackErrorMessage(grant.error, hostName))
      return
    }
    if (grant.value.teamId !== teamId) {
      setError(
        t(
          'bots.slack.workspaces.otherTeam',
          'That token is for another workspace. Orca keeps it for that workspace.'
        )
      )
      return
    }
    toast.success(t('bots.slack.workspaces.reconnected', 'Slack workspace reconnected.'))
    onOpenChange(false)
  }

  return (
    <Dialog open={teamId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t('bots.slack.workspaces.reconnectTitle', 'Reconnect Slack workspace')}
          </DialogTitle>
          <DialogDescription>
            {t('bots.slack.workspaces.reconnectFor', 'Workspace {{teamId}}', { teamId })}
          </DialogDescription>
        </DialogHeader>
        <SlackConfigTokenForm
          submitLabel={t('bots.slack.workspaces.reconnect', 'Reconnect')}
          busy={busy}
          error={error}
          onSubmit={(token) => void submit(token)}
        />
      </DialogContent>
    </Dialog>
  )
}

/**
 * Settings › Bots › Slack workspaces: the host account's grant per workspace, renewed or forgotten
 * here. `account` names the Orca account the grants belong to; `hostId` answers for it, and
 * `botHostIds` are every computer on it, whose bots share its grants.
 */
export function SlackWorkspacesSettings({
  hostId,
  botHostIds,
  account
}: {
  hostId: ExecutionHostId
  botHostIds: readonly ExecutionHostId[]
  account: string | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const hostName = useBotHostLabel(hostId)
  const workspaces = slackWorkspaces(useBots().filter((bot) => botHostIds.includes(bot.hostId)))
  const [reconnecting, setReconnecting] = useState<string | null>(null)

  const forget = async (teamId: string): Promise<void> => {
    const result = await botSlackCalls(hostId).forgetGrant({ teamId })
    if (!result.ok) {
      toast.error(botSlackErrorMessage(result.error, hostName))
      return
    }
    toast.success(
      t(
        'bots.slack.workspaces.forgotten',
        'Forgotten. Bots already there stay in Slack; new bots there need a new token.'
      )
    )
  }

  // The Connectors list already says when there are none.
  if (workspaces.length === 0) {
    return null
  }
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={t('bots.slack.workspaces.title', 'Slack workspaces')}
        description={
          account
            ? t(
                'bots.slack.workspaces.descriptionFor',
                'Orca Cloud keeps one encrypted token per workspace for {{account}}. The Slack user who connected it owns the bots it installs.',
                { account }
              )
            : t(
                'bots.slack.workspaces.description',
                'For Slack, Orca Cloud keeps one encrypted token per workspace to create each bot’s app.'
              )
        }
      />
      <div className="divide-y divide-border rounded-md border border-border">
        {workspaces.map(({ teamId, bots: teamBots }) => (
          <div key={teamId} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                <SlackTeamLabel bot={teamBots[0]} teamId={teamId} />
              </p>
              <p className="truncate text-xs text-muted-foreground">
                <SlackTeamDetail bots={teamBots} teamId={teamId} />
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setReconnecting(teamId)}>
              {t('bots.slack.workspaces.reconnect', 'Reconnect')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void forget(teamId)}>
              {t('bots.slack.workspaces.forget', 'Forget')}
            </Button>
          </div>
        ))}
      </div>
      <ReconnectDialog
        hostId={hostId}
        teamId={reconnecting}
        onOpenChange={(open) => {
          if (!open) {
            setReconnecting(null)
          }
        }}
      />
    </section>
  )
}

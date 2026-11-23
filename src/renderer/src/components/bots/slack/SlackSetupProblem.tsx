// @protected-copy: drawn inside the security-surface setup dialog
// The Connect Slack dialog's known failures: what happened, one way forward, and the codes under Details.
import React, { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { DialogDisclosure } from '@/components/ui/dialog-parts'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { connectRuntimeHostAndReloadProjects } from '@/components/status-bar/host-connections/runtime-environment-explicit-connect'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { BotHostOutage } from '../use-bot-host-outage'
import type { BotSlackSetupStep } from './use-bot-slack-setup'

/** Slack refused the app or the token that makes it: both are fixed with a new token. */
const TOKEN_REJECTED_CODES: ReadonlySet<string> = new Set(['slack_refused', 'grant_expired'])

export type SlackSetupProblem =
  | { kind: 'reconnecting' | 'offline'; code: string; environmentId: string }
  | { kind: 'other-user' | 'expired'; teamId: string }
  | { kind: 'token-rejected'; code: string; teamId?: string }

/** The step's known failure, or null for every other step, and for failures still said in one line. */
export function slackSetupProblem(
  step: BotSlackSetupStep,
  outage: BotHostOutage | null
): SlackSetupProblem | null {
  switch (step.kind) {
    case 'other-user':
    case 'expired':
      return { kind: step.kind, teamId: step.teamId }
    case 'failed':
      // This computer's own sign-in lapsing is answered in place, whatever the server is doing.
      if (outage && !step.local) {
        return { kind: outage.kind, code: step.code, environmentId: outage.environmentId }
      }
      return TOKEN_REJECTED_CODES.has(step.code)
        ? {
            kind: 'token-rejected',
            code: step.code,
            ...(step.teamId ? { teamId: step.teamId } : {})
          }
        : null
    default:
      return null
  }
}

function problemCode(problem: SlackSetupProblem): string {
  switch (problem.kind) {
    case 'other-user':
      return 'other_user'
    case 'expired':
      return 'link_expired'
    default:
      return problem.code || 'unknown'
  }
}

/** The technical lines under Details, for whoever reads them out to support. */
export function slackSetupProblemDetails(
  problem: SlackSetupProblem,
  where: { botName: string; hostName: string | null }
): string {
  const teamId = 'teamId' in problem ? problem.teamId : undefined
  return [
    `code: ${problemCode(problem)}`,
    `computer: ${where.hostName ?? 'this computer'}`,
    `bot: ${where.botName}`,
    ...(problem.kind === 'reconnecting' || problem.kind === 'offline'
      ? [`connection: ${problem.kind}`]
      : []),
    ...(teamId ? [`workspace: ${teamId}`] : [])
  ].join('\n')
}

function problemWords(
  t: Translate,
  problem: SlackSetupProblem,
  botName: string,
  hostName: string
): { headline: string; next: string } {
  switch (problem.kind) {
    case 'reconnecting':
      return {
        headline: t('bots.slack.problem.reconnecting', 'Waiting for {{host}} to reconnect…', {
          host: hostName
        }),
        next: t(
          'bots.slack.problem.reconnectingNext',
          'Slack setup starts again by itself once {{host}} is back. You don’t need to start over or paste a token.',
          { host: hostName }
        )
      }
    case 'offline':
      return {
        headline: t('bots.slack.problem.offline', 'Orca can’t reach {{host}}.', { host: hostName }),
        next: t(
          'bots.slack.problem.offlineNext',
          'Check that Orca is running on {{host}}, then reconnect. Slack setup starts again once {{host}} is back.',
          { host: hostName }
        )
      }
    case 'other-user':
      return {
        headline: t(
          'bots.slack.problem.otherUser',
          'A different Slack account approved the connection.'
        ),
        next: t(
          'bots.slack.problem.otherUserNext',
          'Someone signed in to another Slack account approved the Slack link, so {{bot}} can’t act as you. Get a new link and approve it while signed in to your own Slack account.',
          { bot: botName }
        )
      }
    case 'expired':
      return {
        headline: t(
          'bots.slack.problem.expired',
          'The Slack link expired before the connection was approved.'
        ),
        next: t(
          'bots.slack.problem.expiredNext',
          'Get a new link and approve the connection in Slack.'
        )
      }
    case 'token-rejected':
      return {
        headline: t('bots.slack.problem.tokenRejected', 'Slack rejected this workspace’s token.'),
        next: t(
          'bots.slack.problem.tokenRejectedNext',
          'This happens after the Slack app was removed or the token was revoked. Replace the token to set up {{bot}} again.',
          { bot: botName }
        )
      }
  }
}

export function SlackSetupProblemStep({
  problem,
  botName,
  hostName,
  onClose,
  onNewLink,
  onReplaceToken
}: {
  problem: SlackSetupProblem
  botName: string
  hostName: string | null
  onClose: () => void
  onNewLink: (teamId: string) => void
  onReplaceToken: (teamId: string | undefined) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [connecting, setConnecting] = useState(false)
  const mountedRef = useMountedRef()
  const host = hostName ?? t('bots.host.thisComputer', 'this computer')
  const { headline, next } = problemWords(t, problem, botName, host)
  const action = ((): React.JSX.Element | null => {
    switch (problem.kind) {
      // Setup starts again on its own once the server answers.
      case 'reconnecting':
        return null
      case 'offline':
        return (
          <Button
            autoFocus
            disabled={connecting}
            onClick={() => {
              setConnecting(true)
              void connectRuntimeHostAndReloadProjects(problem.environmentId).finally(() => {
                if (mountedRef.current) {
                  setConnecting(false)
                }
              })
            }}
          >
            {t('bots.slack.problem.reconnect', 'Reconnect')}
          </Button>
        )
      case 'other-user':
      case 'expired':
        return (
          <Button autoFocus onClick={() => onNewLink(problem.teamId)}>
            {t('bots.slack.setup.newLink', 'Get a new link')}
          </Button>
        )
      case 'token-rejected':
        return (
          <Button autoFocus onClick={() => onReplaceToken(problem.teamId)}>
            {t('bots.slack.problem.replaceToken', 'Replace token')}
          </Button>
        )
    }
  })()
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        {problem.kind === 'reconnecting' ? (
          <p role="status" className="flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" />
            {headline}
          </p>
        ) : (
          <p role="alert" className="text-sm text-destructive">
            {headline}
          </p>
        )}
        <p className="text-sm text-muted-foreground">{next}</p>
      </div>
      <DialogDisclosure label={t('bots.slack.problem.details', 'Details')} variant="code">
        <p className="whitespace-pre-wrap break-all select-text">
          {slackSetupProblemDetails(problem, { botName, hostName })}
        </p>
      </DialogDisclosure>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('bots.slack.setup.close', 'Close')}
        </Button>
        {action}
      </DialogFooter>
    </div>
  )
}

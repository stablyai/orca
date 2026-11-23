// @protected-copy: drawn inside the security-surface setup dialog
// One run of "Add <bot> to Slack": its steps from the cloud's state, Slack's install page, and the
// token form; the dialog draws them.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useBots } from '@/lib/bot-catalog'
import { botSlackCalls } from '@/lib/bot-connector-host-calls'
import { openBotHostPageOrSay } from '@/lib/bot-host-page'
import { refreshBotSlack, slackReturnUrl, slackTeamState, useBotSlack } from '@/lib/bot-slack-state'
import { botSlackApps, type Bot } from '../../../../../shared/bot-types'
import { BOT_SLACK_DESKTOP_ERRORS } from '../../../../../shared/connector-bot-slack-contract'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { botSlackErrorMessage } from './bot-slack-copy'
import { useBotHostLabel } from '../use-bot-host-label'
import { slackSetupShownStep } from './slack-setup-shown-step'
import { hostBots, knownSlackTeam, otherSlackTeams } from './slack-setup-teams'
import {
  slackInstallLink as installLink,
  useSlackLinkExpired,
  type SlackInstallLink
} from './slack-install-link'
import { openedKey, openedSlackPages, type OpenedSlackPage } from './slack-opened-pages'

export type BotSlackSetupStep =
  | { kind: 'checking' }
  /** Another workspace for a bot already in Slack: one this computer's bots are in, or a new one. */
  | { kind: 'pick'; teamIds: string[] }
  /**
   * `teamId`: the workspace whose token lapsed. `mine`: that token is this desktop's own Orca
   * account's, from a hand-off; the new one is saved there and the hand-off runs again.
   */
  | { kind: 'token'; reconnect: boolean; error: string | null; teamId?: string; mine?: boolean }
  /** `handOff`: this desktop's own Orca account creates the app. */
  | { kind: 'setting-up'; handOff?: boolean }
  /** A paired computer's bot: its app is made; Slack's page opens only on Approve in Slack. */
  | { kind: 'ready'; teamId: string; link: SlackInstallLink }
  /** `returnUrl`: where Slack's page sends the browser back, read at once on landing. */
  | {
      kind: 'waiting'
      teamId: string
      returnUrl: string | null
      link: SlackInstallLink | null
      copied: boolean
    }
  | { kind: 'expired'; teamId: string }
  /** Slack says a Slack user other than the token's approved the link. */
  | { kind: 'other-user'; teamId: string }
  | { kind: 'uncertain'; teamId: string }
  /** `teamId`: the workspace it is in, whose people the owner then picks. */
  /** `setupState`: the install link this flow installed with, so its identity pick applies at once. */
  | { kind: 'installed'; teamId: string; setupState?: string }
  /** `code` is the desktop error code, so a signed-out failure can offer Sign in; `local`: this
   *  computer's own account failed. `teamId`, `handOff`: the workspace and step a recovery resumes. */
  | { kind: 'failed'; code: string; local?: true; teamId?: string; handOff?: boolean }

/** One open of the dialog; compared by identity. `started`: its setup ran, which it does once. */
type SetupMount = { readonly openedAt: number; started: boolean }

/** `teamId`: finish or update the bot's app in that workspace; none: its first, or another one. */
export function useBotSlackSetup(
  bot: Bot,
  teamId: string | undefined,
  /** Slack's page opened in Orca's browser, behind the dialog. */
  onStepAside?: () => void
): {
  step: BotSlackSetupStep
  /** Setup again, on the owner's Try again. */
  retry: (teamId?: string, handOff?: boolean) => Promise<void>
  setUp: (teamId: string, mount?: SetupMount | null) => Promise<void>
  /** This desktop's own Orca account creates the app with its token for `teamId`. */
  handOff: (teamId: string) => Promise<void>
  submitToken: (token: string) => Promise<void>
  /** The token form; `teamId`: the workspace whose saved token Slack refused. */
  pasteToken: (teamId?: string, mine?: boolean) => void
  /** A paired computer's bot: opens Slack's page on that computer. */
  approve: () => void
  /** A paired computer's bot: a fresh link for `teamId`, opened on that computer at once. */
  openNewLink: (teamId: string) => Promise<void>
  /** A paired computer's bot: the link, for approving in another browser. */
  /** `byHand`: already copied from the field, so only the dialog waits. */
  copyLink: (byHand?: boolean) => Promise<void>
} {
  // Subscribed so the host's bot list is read when setup starts.
  useBots()
  const hostName = useBotHostLabel(bot.hostId)
  const [step, setStep] = useState<BotSlackSetupStep>({ kind: 'checking' })

  // A dismissed dialog never goes on to open Slack when a slow answer lands, nor does a mount that
  // was replaced (StrictMode mounts twice, each starting setup).
  const mounted = useRef<SetupMount | null>(null)
  useEffect(() => {
    const mount: SetupMount = { openedAt: Date.now(), started: false }
    mounted.current = mount
    return () => {
      mounted.current = null
    }
  }, [])

  const remember = useCallback(
    (teamId: string, link: SlackInstallLink): OpenedSlackPage => {
      const opened = { returnUrl: slackReturnUrl(link.authorizeUrl), link }
      openedSlackPages.set(openedKey(bot, teamId), opened)
      return opened
    },
    [bot]
  )
  const wait = useCallback(
    (teamId: string, link: SlackInstallLink, copied: boolean) =>
      setStep({ kind: 'waiting', teamId, ...remember(teamId, link), copied }),
    [remember]
  )

  // Slack's page on the bot's computer; stays on the step when nothing there could open it.
  const openOnHost = useCallback(
    (teamId: string, link: SlackInstallLink): boolean => {
      const opened = openBotHostPageOrSay(bot.hostId, link.authorizeUrl, { bot, local: 'system' })
      if (opened === 'unrouted') {
        return false
      }
      wait(teamId, link, false)
      if (opened === 'orca-browser') {
        onStepAside?.()
      }
      return true
    },
    [bot, wait, onStepAside]
  )

  // This computer's own bots open Slack's page at once, as before. A paired computer's wait for
  // Open Slack, so Copy link stays in reach before the dialog folds into the pill, unless the
  // owner already asked to open it.
  const install = useCallback(
    async (teamId: string, link: SlackInstallLink, mount: SetupMount | null, openNow = false) => {
      // The wait reads this attempt's state, never the last one's refusal.
      const fresh = refreshBotSlack(bot)
      const current = (): boolean => mount !== null && mounted.current === mount
      if (!current()) {
        return
      }
      if (bot.hostId === LOCAL_EXECUTION_HOST_ID) {
        // Remembered at once: stepping aside mounts the flow anew, which must not open Slack again.
        remember(teamId, link)
        if (
          openBotHostPageOrSay(bot.hostId, link.authorizeUrl, { bot, local: 'system' }) ===
          'orca-browser'
        ) {
          onStepAside?.()
        }
      }
      await fresh
      if (!current()) {
        return
      }
      if (bot.hostId === LOCAL_EXECUTION_HOST_ID) {
        wait(teamId, link, false)
      } else if (!openNow || !openOnHost(teamId, link)) {
        setStep({ kind: 'ready', teamId, link })
      }
    },
    [bot, onStepAside, remember, wait, openOnHost]
  )

  const setUp = useCallback(
    // `mount` is the one the action began in.
    async (teamId: string, mount = mounted.current, openNow = false) => {
      setStep({ kind: 'setting-up' })
      const result = await botSlackCalls(bot.hostId).setUpApp({
        botId: bot.id,
        teamId
      })
      if (result.ok) {
        await install(teamId, installLink(result.value), mount, openNow)
        return
      }
      setStep(
        result.error === 'grant_expired'
          ? { kind: 'token', reconnect: true, error: null, teamId }
          : { kind: 'failed', code: result.error, teamId }
      )
    },
    [bot, install]
  )

  const handOff = useCallback(
    // `mount` is the one the action began in.
    async (teamId: string, mount: SetupMount | null) => {
      setStep({ kind: 'setting-up', handOff: true })
      const host = botSlackCalls(bot.hostId)
      const code = await host.handOff({ botId: bot.id, teamId })
      // Spent by this desktop's own Orca account, from this window only.
      // A rejected bridge call is a plain failure, so the spinner always ends.
      const app = code.ok
        ? await window.api.slackHandOff
            .redeem({ code: code.value.code })
            .catch(() => ({ ok: false as const, error: BOT_SLACK_DESKTOP_ERRORS.failed }))
        : code
      if (!app.ok) {
        // Installed meanwhile (by anyone): the dialog shows it, with who can ask.
        if (app.error === 'already_installed') {
          void refreshBotSlack(bot)
          setStep({ kind: 'installed', teamId })
          return
        }
        // The server turned out to be on this desktop's own account: today's paste flow.
        if (app.error === 'same_account') {
          setStep({ kind: 'token', reconnect: false, error: null })
          return
        }
        setStep(
          app.error === 'grant_expired' && code.ok
            ? { kind: 'token', reconnect: true, error: null, teamId, mine: true }
            : {
                kind: 'failed',
                code: app.error,
                teamId,
                handOff: true,
                local: code.ok || undefined
              }
        )
        return
      }
      // The host records the app as its own cloud reads it; the install goes on either way.
      await host.adoptApp({ botId: bot.id, teamId })
      await install(teamId, installLink(app.value), mount)
    },
    [bot, install]
  )

  // `resume`: after an outage, that workspace's state is read again, never a fresh pick or a stale link.
  const start = useCallback(
    async (resume?: string, viaHandOff?: boolean) => {
      const mount = mounted.current
      setStep({ kind: 'checking' })
      const view = await refreshBotSlack(bot)
      if (view.status !== 'ready') {
        setStep({ kind: 'failed', code: view.status === 'failed' ? view.error : '' })
        return
      }
      // Opened from Add a connector on a bot already in Slack: another workspace.
      if (resume === undefined && teamId === undefined && botSlackApps(bot).length > 0) {
        const teamIds = otherSlackTeams(hostBots(bot), bot)
        return setStep(
          teamIds.length > 0
            ? { kind: 'pick', teamIds }
            : { kind: 'token', reconnect: false, error: null }
        )
      }
      const slack = slackTeamState(view.slack, resume ?? teamId)
      switch (slack.state) {
        // An app whose manifest is out of date gets the new one, then Slack's page for the new scopes.
        // One that only predates optional permissions is opened here for nothing else: the same path.
        case 'installed':
          return slack.updateNeeded || slack.updateAvailable
            ? await setUp(slack.teamId, mount)
            : setStep({ kind: 'installed', teamId: slack.teamId })
        // The dialog opens on the owner's own click, so an app made earlier (or kept by a removal)
        // goes straight on to Slack's install page with a fresh attempt.
        case 'created': {
          const opened = resume ? undefined : openedSlackPages.get(openedKey(bot, slack.teamId))
          return opened
            ? setStep({ kind: 'waiting', teamId: slack.teamId, ...opened, copied: false })
            : await (viaHandOff ? handOff : setUp)(slack.teamId, mount)
        }
        case 'uncertain':
          return setStep({ kind: 'uncertain', teamId: slack.teamId })
        case 'grant_expired':
          return setStep({ kind: 'token', reconnect: true, error: null, teamId: slack.teamId })
        case 'not_created': {
          const knownTeam = resume ?? teamId ?? knownSlackTeam(hostBots(bot), bot.id)
          return knownTeam
            ? await (viaHandOff && resume ? handOff : setUp)(knownTeam, mount)
            : setStep({ kind: 'token', reconnect: false, error: null })
        }
      }
    },
    [bot, teamId, setUp, handOff]
  )

  const submitToken = useCallback(
    async (refreshToken: string) => {
      if (step.kind !== 'token') {
        return
      }
      const { reconnect, mine } = step
      const mount = mounted.current
      setStep({ kind: 'setting-up', handOff: mine })
      // This desktop's own token goes to its own account; otherwise to the bot's host's, as before.
      const grant = await botSlackCalls(mine ? LOCAL_EXECUTION_HOST_ID : bot.hostId).saveGrant({
        refreshToken
      })
      if (!grant.ok) {
        setStep({
          kind: 'token',
          reconnect,
          error: botSlackErrorMessage(grant.error, mine ? null : hostName),
          ...(step.teamId ? { teamId: step.teamId } : {}),
          ...(mine ? { mine } : {})
        })
        return
      }
      await (mine ? handOff : setUp)(grant.value.teamId, mount)
    },
    [step, bot.hostId, hostName, setUp, handOff]
  )

  const approve = useCallback(() => {
    if ((step.kind === 'ready' || step.kind === 'waiting') && step.link) {
      openOnHost(step.teamId, step.link)
    }
  }, [step, openOnHost])

  const copyLink = useCallback(
    async (byHand = false) => {
      if ((step.kind === 'ready' || step.kind === 'waiting') && step.link) {
        if (!byHand) {
          await window.api.ui.writeClipboardText(step.link.authorizeUrl)
        }
        wait(step.teamId, step.link, true)
      }
    },
    [step, wait]
  )

  const link = step.kind === 'waiting' || step.kind === 'ready' ? step.link : null
  const expired = useSlackLinkExpired(link?.expiresAt ?? null)
  // The shared state follows the install, so a finished one shows here and on every other surface.
  const awaitingInstall = step.kind === 'waiting' && !expired
  const view = useBotSlack(bot, awaitingInstall, step.kind === 'waiting' ? step.returnUrl : null)
  const waited =
    step.kind === 'waiting' && view.status === 'ready'
      ? slackTeamState(view.slack, step.teamId)
      : null
  // Still behind, on required or optional permissions: the approval this flow waits for isn't in.
  const installed = waited?.state === 'installed' && !waited.updateNeeded && !waited.updateAvailable
  const otherUser = waited?.state === 'created' && waited.oauthFailure === 'other_user'
  const shown = slackSetupShownStep(step, { installed, otherUser, expired })

  // Once per open: a bot re-read while setup runs (each refresh does) is a new object and a new
  // `start`, and running it again would open Slack again while the update still waits.
  useEffect(() => {
    const mount = mounted.current
    if (mount && !mount.started) {
      mount.started = true
      void start()
    }
  }, [start])

  const pasteToken = useCallback(
    (lapsed?: string, mine?: boolean) =>
      setStep({ kind: 'token', reconnect: Boolean(lapsed), error: null, teamId: lapsed, mine }),
    []
  )
  return {
    step: shown,
    retry: start,
    setUp,
    handOff: (handOffTeam: string) => handOff(handOffTeam, mounted.current),
    submitToken,
    pasteToken,
    approve,
    openNewLink: (newLinkTeam: string) => setUp(newLinkTeam, mounted.current, true),
    copyLink
  }
}

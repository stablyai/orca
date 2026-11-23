// A tool's sign-in as every surface shows it (the Connectors row, Settings › Tools, the chat's
// tool-added card): one status, one line and one action, whether Orca signs in or the agent's CLI.
import type { BotRef } from '@/lib/bot-hosts'
import { useState } from 'react'
import { toast } from 'sonner'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { BotOwnTool, BotToolProblem } from '../../../../shared/bot-tools'
import {
  botToolSignInFace,
  type BotToolSignInFace
} from '../../../../shared/bots/bot-tool-sign-in-face'
import {
  botToolErrorMessage,
  useBotToolHostSignIn,
  connectBotTool,
  openBotToolSignInPage,
  useBotToolSignIn
} from './bot-tools-client'

/**
 * A sign-in face in words, one mapping for every surface: `line` for a row (Connectors, Settings ›
 * Tools, the chat card) and `need` for Needs you. Never signed in asks for a first sign-in; only a
 * lost one asks to sign in again. Null `need`: the face is not a sign-in to ask for.
 */
export function botToolSignInWords(
  face: BotToolSignInFace | null,
  t: Translate,
  name: string,
  /** The computer the bot runs on, for "Update Orca on …". */
  hostName: string | null = null
): { line: string | null; need: string | null } {
  switch (face) {
    case 'signed-in':
      return { line: t('bots.toolApp.signedIn', 'Signed in'), need: null }
    case 'needs-sign-in':
      return {
        line: t('bots.toolApp.needsSignIn', 'Needs sign-in'),
        need: t('bots.needs.signIn', '{{name}} needs you to sign in.', { name })
      }
    case 'sign-in-again':
      return {
        line: t('bots.toolApp.signInAgain', 'Sign in again'),
        need: t('bots.needs.signInAgain', '{{name}} needs you to sign in again.', { name })
      }
    case 'waiting':
      return { line: t('bots.toolApp.finishInBrowser', 'Finish in browser'), need: null }
    case 'finishing':
      return { line: t('bots.toolApp.finishing', 'Finishing sign-in…'), need: null }
    case 'update-needed':
      return { line: updateRowLine(t, hostName), need: null }
    case 'unreachable':
      return { line: t('bots.toolApp.cantReach', 'Can’t reach'), need: null }
    case 'unsupported':
      return { line: t('bots.apps.unsupported', 'This app isn’t supported yet'), need: null }
    case 'interrupted':
      return {
        line: t('bots.toolApp.interrupted', 'Sign-in interrupted by restart'),
        need: null
      }
    case null:
      return { line: null, need: null }
  }
}

export type BotToolSignInAction = {
  face: BotToolSignInFace | null
  /** The status line; null with no face. */
  line: string | null
  /** The button that signs in, when one is due; it starts a new sign-in that replaces any waiting. */
  action: { label: string; run: () => void; busy: boolean } | null
  /** A sign-in from this window waits on the address its browser lands on, pasted back. */
  pasteBack: boolean
  /** A sign-in from this window is under way. */
  started: boolean
  /** Starts a sign-in whatever the face (a signed-in row's "Sign in again"). */
  signIn: () => void
}

export function useBotToolSignInAction(
  bot: BotRef,
  tool: BotOwnTool,
  problem: BotToolProblem | undefined
): BotToolSignInAction {
  const t = useTranslate()
  const { active: started, failure, hostName } = useBotToolSignIn(bot, tool.name)
  const [busy, setBusy] = useState(false)
  const host = useBotToolHostSignIn(bot, tool.name)
  const hosted = started ? host : null
  const face = botToolSignInFace(tool, problem, started, failure, hosted?.state === 'finishing')
  const run = (): void => {
    setBusy(true)
    void connectBotTool(bot, tool.name, Boolean(tool.signIn))
      .catch((error: unknown) => toast.error(botToolErrorMessage(error)))
      .finally(() => setBusy(false))
  }
  // The host's page can be opened again as it is; any other sign-in starts afresh.
  const hostedUrl = hosted?.paste ? hosted.url : null
  const openAgain = hostedUrl ? () => openBotToolSignInPage(hostedUrl) : run
  const signIn = t('bots.toolApp.signIn', 'Sign in')
  const actionLabel =
    face === 'needs-sign-in' || face === 'sign-in-again'
      ? signIn
      : face === 'waiting'
        ? t('bots.apps.openPageAgain', 'Open page again')
        : face === 'unreachable'
          ? t('bots.composio.tryAgain', 'Try again')
          : face === 'interrupted'
            ? t('bots.composio.tryAgain', 'Try again')
            : null
  const { line } = botToolSignInWords(face, t, tool.name, hostName)
  return {
    face,
    line,
    // A pasted sign-in's page opens again beside its paste field, so a narrow row keeps one line each.
    action:
      actionLabel && !(face === 'waiting' && hostedUrl)
        ? { label: actionLabel, run: face === 'waiting' ? openAgain : run, busy }
        : null,
    pasteBack:
      started &&
      (hosted
        ? hosted.paste && hosted.state === 'waiting'
        : !tool.signIn && problem?.kind === 'sign-in'),
    started,
    signIn: run
  }
}

/** A row's short "Update Orca on <host>". */
function updateRowLine(t: Translate, host: string | null): string {
  return host
    ? t('bots.toolApp.updateHostShort', 'Update Orca on {{host}}', { host })
    : t('bots.toolApp.updateServerShort', 'Update Orca on the server')
}

/** "Update Orca on <host> to sign in to apps", for a host whose Orca can't sign in for this device. */
export function updateLine(t: Translate, host: string | null): string {
  return host
    ? t('bots.toolApp.updateHost', 'Update Orca on {{host}} to sign in to apps', { host })
    : t('bots.toolApp.updateServer', 'Update Orca on the server to sign in to apps')
}

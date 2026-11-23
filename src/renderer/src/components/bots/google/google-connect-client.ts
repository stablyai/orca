// Settings › Google, read and changed on the host whose Google it is: this computer, or the paired
// server Settings points at. That host keeps the sign-ins; this window sees emails and states only.
import { botTarget, callBotRpc, type BotOnHost, type BotRef } from '@/lib/bot-hosts'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { googleSignInRunError } from './google-copy'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { botHostUnroutedMessage, openBotHostPageOrSay, openOnServer } from '@/lib/bot-host-page'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import type { GoogleClientView } from '../../../../../shared/google/google-client-config'
import {
  GOOGLE_CONNECT_RUNTIME_CAPABILITY,
  type GoogleAccountView,
  type GoogleSignInPrompt,
  type GoogleSignInStatus,
  type GoogleStatusView
} from '../../../../../shared/google/google-connect-types'
import { googleAppExportFileName } from '../../../../../shared/google/google-console-setup'
import type { GoogleServiceChoice } from '../../../../../shared/google/google-scopes'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { Bot } from '../../../../../shared/bot-types'
import { errorMessage } from '../../../../../shared/errors/error-message'
import { googleReachAreas, type GoogleReachArea } from '../../../../../shared/bots/bot-access-reach'
import { botConnectorRowKey, forgetBotConnectorPage } from '../bot-connector-page'

export type GoogleHostView =
  | { status: 'loading' }
  /** A paired server on an Orca without Google. */
  | { status: 'update-server' }
  | { status: 'failed'; error: string }
  | { status: 'ready'; google: GoogleStatusView }

const keyOf = (target: RuntimeClientTarget): string =>
  target.kind === 'local' ? 'local' : `env:${target.environmentId}`

/** A host's last status, which read produced it (reads are numbered in the order they start), and
 *  whether a newer read has started and not answered yet. */
type GoogleHostEntry = { view: GoogleHostView; read: number; pending: boolean }

let readsStarted = 0
const latestReadOf = new Map<string, number>()
const views = new Map<string, GoogleHostEntry>()
const listeners = new Set<() => void>()
function publish(target: RuntimeClientTarget, view: GoogleHostView, read: number): void {
  const key = keyOf(target)
  // A read that started later owns the status, even if this one answers after it.
  if (latestReadOf.get(key) !== read) {
    return
  }
  views.set(key, { view, read, pending: false })
  notify()
}
function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}
/** A read starts: the host's last status stays shown, marked as being read again. */
function startRead(target: RuntimeClientTarget): number {
  const key = keyOf(target)
  const read = ++readsStarted
  latestReadOf.set(key, read)
  const entry = views.get(key)
  if (entry && !entry.pending) {
    views.set(key, { ...entry, pending: true })
    notify()
  }
  return read
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

async function supportsGoogle(target: RuntimeClientTarget): Promise<boolean> {
  return (
    target.kind === 'local' ||
    runtimeEnvironmentSupportsCapability(target.environmentId, GOOGLE_CONNECT_RUNTIME_CAPABILITY)
  )
}

/** Reads the host's Google again; `check` re-reads every account's services at Google first. */
export async function refreshGoogle(
  target: RuntimeClientTarget,
  options: { check?: boolean } = {}
): Promise<GoogleHostView> {
  const read = startRead(target)
  let view: GoogleHostView
  try {
    view = (await supportsGoogle(target))
      ? {
          status: 'ready',
          google: await callRuntimeRpc<GoogleStatusView>(
            target,
            'google.status',
            options.check ? { check: true } : {}
          )
        }
      : { status: 'update-server' }
  } catch (error) {
    view = { status: 'failed', error: errorMessage(error) }
  }
  publish(target, view, read)
  return view
}

/** The host's Google, read again each time something starts showing it (the host answers from memory). */
export function useGoogleHost(target: RuntimeClientTarget, shown = true): GoogleHostView {
  return useGoogleHostEntry(target, shown)?.view ?? { status: 'loading' }
}

function useGoogleHostEntry(
  target: RuntimeClientTarget,
  shown = true
): GoogleHostEntry | undefined {
  const key = keyOf(target)
  const entry = useSyncExternalStore(subscribe, () => views.get(key))
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  useEffect(() => {
    if (shown) {
      void refreshGoogle(runtimeTargetForOwnerEnvironment(environmentId))
    }
  }, [environmentId, shown])
  return entry
}

/** What Google reaches through this bot: nothing unless it is on for it, then only the services
 *  ready on an account signed in here. `unknown`: it is on, and the latest read, started since this
 *  mounted and answered, hasn't shown it reaches nothing (still reading, being read again, the read
 *  failed, or only an older status says so), so it may reach anything. A fresh read of a server
 *  without Google (`update-server`) reaches nothing. */
export function useBotGoogleReach(bot: Pick<Bot, 'google'> & BotOnHost): {
  areas: GoogleReachArea[]
  unknown: boolean
} {
  // Reads already started may predate a sign-in or an update, so only a later one can say "nothing".
  const [readsBeforeMount] = useState(() => readsStarted)
  const entry = useGoogleHostEntry(botTarget(bot))
  if (bot.google !== true) {
    return { areas: [], unknown: false }
  }
  // "Nothing" holds only from the latest read; a newer one still reading may find access.
  const current = entry !== undefined && entry.read > readsBeforeMount && !entry.pending
  const view = entry?.view
  if (view?.status === 'ready') {
    const areas = googleReachAreas(view.google.accounts)
    return { areas, unknown: areas.length === 0 && !current }
  }
  return { areas: [], unknown: !(current && view?.status === 'update-server') }
}

export async function importGoogleApp(
  target: RuntimeClientTarget,
  file: string
): Promise<GoogleClientView> {
  const { client } = await callRuntimeRpc<{ client: GoogleClientView }>(
    target,
    'google.client.import',
    { file }
  )
  await refreshGoogle(target)
  return client
}

export async function exportGoogleApp(target: RuntimeClientTarget): Promise<string> {
  const { file } = await callRuntimeRpc<{ file: string }>(target, 'google.client.export', {})
  return file
}

/** Share with teammates: the team's app as a file, saved where the person picks. */
export async function saveGoogleAppForTeammates(
  target: RuntimeClientTarget,
  projectId: string | undefined
): Promise<boolean> {
  const text = await exportGoogleApp(target)
  return window.api.googleSetup.saveAppFile({ text, name: googleAppExportFileName(projectId) })
}

/** Share with teammates from any surface: saves the file, then says so in a toast. */
export function shareGoogleApp(target: RuntimeClientTarget, projectId: string | undefined): void {
  void saveGoogleAppForTeammates(target, projectId).then(
    (saved) => {
      if (saved) {
        toast.success(
          translate('bots.google.share.saved', 'Saved. Send the file to your teammates.')
        )
      }
    },
    () => toast.error(translate('bots.google.share.failed', 'Couldn’t save the file. Try again.'))
  )
}

export async function disconnectGoogle(
  target: RuntimeClientTarget,
  account: string,
  revoke: boolean
): Promise<void> {
  await callRuntimeRpc(target, 'google.disconnect', { account, revoke })
  await refreshGoogle(target)
}

/** The bot toggle lives with the bot, on its host. */
export async function setBotGoogle(bot: BotRef, on: boolean): Promise<void> {
  await callBotRpc(bot, 'google.bot.set', { botId: bot.id, on })
  if (!on) {
    forgetBotConnectorPage(botConnectorRowKey(bot, 'google'))
  }
  await refreshGoogle(botTarget(bot))
}

/** Google sign-in and "Open in my browser": the person's default browser, where their accounts are. */
export function openInMyBrowser(url: string): void {
  void window.api.shell.openUrl(url)
}

const SIGN_IN_WAIT_MS = 60_000

/**
 * Where the person finishes Google's page: a browser that returns to the host itself, or (a paired
 * server, whose return this device can't reach) any browser, with the address pasted back.
 */
export type GoogleSignInWay = 'browser' | 'paste'

type SignInRun = {
  target: RuntimeClientTarget
  flowId: string | null
  cancelled: boolean
  /** Where Google's page opened, for Open again. */
  reopen: (url: string) => void
}

let running: SignInRun | null = null

function nextStatus(run: SignInRun, status: GoogleSignInStatus): Promise<GoogleSignInStatus> {
  return callRuntimeRpc<GoogleSignInStatus>(
    run.target,
    'google.signIn.wait',
    { flowId: status.flowId, afterRevision: status.revision },
    { timeoutMs: SIGN_IN_WAIT_MS }
  )
}

/** Follows the flow until Google's link is ready, or it ends first. */
async function settle(run: SignInRun, first: GoogleSignInStatus): Promise<GoogleSignInStatus> {
  let status = first
  while (
    !(status.phase === 'waiting' && status.prompt) &&
    status.phase !== 'signedIn' &&
    status.phase !== 'failed' &&
    status.phase !== 'cancelled' &&
    !run.cancelled
  ) {
    status = await nextStatus(run, status)
  }
  return status
}

async function untilSettled(run: SignInRun, first: GoogleSignInStatus): Promise<GoogleAccountView> {
  let status = first
  while (status.phase !== 'signedIn') {
    if (status.phase === 'failed' || status.phase === 'cancelled' || run.cancelled) {
      throw new Error(
        run.cancelled || status.phase === 'cancelled'
          ? googleSignInRunError('cancelled')
          : (status.error ?? googleSignInRunError('failed'))
      )
    }
    status = await nextStatus(run, status)
  }
  if (!status.account) {
    throw new Error(googleSignInRunError('noAccount'))
  }
  return status.account
}

/**
 * Signs a Google account in on `target`, which keeps it: the host opens its browser, or this window
 * opens the link. `onPrompt` gets the link, for Open again. A browser that can't reach the host
 * finishes by pasting its address (google.finishSignIn).
 */
export async function connectGoogle(
  target: RuntimeClientTarget,
  // `bot`: whose workspace a server's page opens in.
  request: { services: readonly GoogleServiceChoice[]; account?: string; bot?: BotRef },
  onPrompt: (prompt: GoogleSignInPrompt, way: GoogleSignInWay) => void
): Promise<GoogleAccountView> {
  if (running) {
    throw new Error(googleSignInRunError('alreadyRunning'))
  }
  const run: SignInRun = { target, flowId: null, cancelled: false, reopen: openInMyBrowser }
  running = run
  try {
    const started = await callRuntimeRpc<GoogleSignInStatus>(target, 'google.signIn.start', {
      services: [...request.services],
      ...(request.account ? { account: request.account } : {})
    })
    run.flowId = started.flowId
    const waiting = await settle(run, started)
    if (waiting.phase !== 'waiting' || !waiting.prompt) {
      return await untilSettled(run, waiting)
    }
    // A paired server's return lands on its own loopback: its own page in Orca's browser reaches it
    // through the server, and a desktop never opens it anywhere else, whose logins aren't the
    // server's. The web and the phone have no Orca browser and finish by paste.
    const serverHost =
      target.kind === 'environment' && !isPairedWebClientWindow()
        ? toRuntimeExecutionHostId(target.environmentId)
        : null
    const onServer =
      serverHost !== null && openOnServer(serverHost, waiting.prompt.authorizeUrl, request.bot)
    // Its return reaches only the server's loopback, so it never reopens in the system browser.
    run.reopen = onServer
      ? (url) => void openBotHostPageOrSay(serverHost, url, { bot: request.bot, local: 'system' })
      : run.reopen
    if (serverHost !== null && !onServer) {
      await callRuntimeRpc(target, 'google.signIn.cancel', { flowId: started.flowId }).catch(
        () => {}
      )
      throw new Error(botHostUnroutedMessage(serverHost))
    }
    const way: GoogleSignInWay =
      onServer || (target.kind === 'local' && !isPairedWebClientWindow()) ? 'browser' : 'paste'
    onPrompt(waiting.prompt, way)
    if (!onServer && (way === 'paste' || !waiting.prompt.browserOpened)) {
      openInMyBrowser(waiting.prompt.authorizeUrl)
    }
    return await untilSettled(run, waiting)
  } finally {
    if (running === run) {
      running = null
    }
    void refreshGoogle(target)
  }
}

/** Open again: Google's page where this sign-in opened it, or the person's browser with none running. */
export const openGoogleSignInAgain = (url: string): void =>
  (running?.reopen ?? openInMyBrowser)(url)

/** Finishes the running sign-in with the address its browser ended on; the host checks it. */
export async function finishGoogleSignInWithAddress(address: string): Promise<void> {
  const run = running
  if (!run?.flowId) {
    throw new Error(googleSignInRunError('notWaiting'))
  }
  await callRuntimeRpc<GoogleSignInStatus>(run.target, 'google.finishSignIn', {
    flowId: run.flowId,
    address: address.trim()
  })
}

/** Stops the sign-in this window runs on its host. */
export async function cancelGoogleSignIn(): Promise<void> {
  const run = running
  if (!run) {
    return
  }
  run.cancelled = true
  if (run.flowId) {
    await callRuntimeRpc(run.target, 'google.signIn.cancel', { flowId: run.flowId }).catch(() => {})
  }
}

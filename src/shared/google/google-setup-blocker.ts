// Where a bot's Google setup is stuck, and the one thing the owner can press to move it on. The setup
// cards draw it and `orca bot google-setup show` prints it, so the bot names only buttons that exist.
import type { GoogleAccountView, GoogleStatusView } from './google-connect-types'
import { GOOGLE_CHOICE_SERVICES, type GoogleServiceChoice } from './google-scopes'
import {
  currentGoogleSetupStep,
  GOOGLE_SETUP_STEPS,
  personDoesGoogleSetupStep,
  type GoogleSetupRun,
  type GoogleSetupStep
} from './google-setup-run'

/** How long a bot's step may sit with no turn running before the card offers Continue. */
export const GOOGLE_SETUP_PAUSED_AFTER_MS = 30_000

export type GoogleSetupAction =
  | { id: 'make-new-key' }
  | { id: 'import-key' }
  /** Sign in again for just these services, ticking every box. */
  | { id: 'allow'; services: GoogleServiceChoice[] }
  /** Drop these services from the setup. */
  | { id: 'continue-without'; services: GoogleServiceChoice[] }
  | { id: 'keep-account'; email: string }
  | { id: 'sign-in-again'; email?: string }
  | { id: 'turn-on'; services: GoogleServiceChoice[] }
  | { id: 'copy-for-admin' }
  | { id: 'check-again' }
  | { id: 'continue' }
  | { id: 'start-over' }
  | { id: 'let-me'; step: GoogleSetupStep }
  | { id: 'done'; step: GoogleSetupStep }

export type GoogleSetupBlocker = (
  | { kind: 'stopped'; step: GoogleSetupStep | null; reason?: string }
  | { kind: 'paused'; step: GoogleSetupStep }
  | { kind: 'needs-user'; step: GoogleSetupStep; note?: string }
  | { kind: 'no-key' }
  /** Google no longer knows the saved key: its client or project was removed. */
  | { kind: 'key-gone' }
  | { kind: 'key-other-project'; keyProjectId: string; projectId: string }
  | { kind: 'other-account'; signedIn: string; wanted: string }
  | { kind: 'signed-out'; email: string }
  | { kind: 'needs-permission'; services: GoogleServiceChoice[] }
  | { kind: 'api-off'; services: GoogleServiceChoice[] }
  | { kind: 'admin-blocked'; services: GoogleServiceChoice[] }
  | { kind: 'check-failed'; services: GoogleServiceChoice[] }
) & {
  /** The main action first; at most one quieter one after it. */
  actions: GoogleSetupAction[]
}

type SetupGoogle = Pick<GoogleStatusView, 'client' | 'accounts' | 'clientKey'>

export type GoogleSetupBlockerInput = {
  run: GoogleSetupRun | null
  google: SetupGoogle | null
  /** Whether the bot's chat has a turn running; null when this reader can't tell. */
  botTurnRunning: boolean | null
  now: number
}

const finished = (run: GoogleSetupRun, step: GoogleSetupStep): boolean => {
  const status = run.steps[step]?.status
  return status === 'done' || status === 'skipped'
}

/** The account the setup connected: the one it was for, or (an imported app names none) the latest. */
export function googleSetupAccount(
  run: Pick<GoogleSetupRun, 'account'>,
  accounts: readonly GoogleAccountView[]
): GoogleAccountView | null {
  const wanted = run.account?.toLowerCase()
  if (wanted) {
    return accounts.find((entry) => entry.email.toLowerCase() === wanted) ?? null
  }
  return accounts.reduce<GoogleAccountView | null>(
    (latest, entry) => (!latest || entry.connectedAt > latest.connectedAt ? entry : latest),
    null
  )
}

/** The chosen services that have a service in this state. */
function choicesIn(
  run: GoogleSetupRun,
  account: GoogleAccountView,
  state: GoogleAccountView['services'][number]['state']
): GoogleServiceChoice[] {
  return (run.services ?? []).filter((choice) =>
    GOOGLE_CHOICE_SERVICES[choice].some((service) =>
      account.services.some((entry) => entry.service === service && entry.state === state)
    )
  )
}

function keyBlocker(run: GoogleSetupRun, google: SetupGoogle): GoogleSetupBlocker | null {
  if (!google.client || (run.newApp && google.client.savedAt < run.startedAt)) {
    return { kind: 'no-key', actions: [{ id: 'make-new-key' }, { id: 'import-key' }] }
  }
  if (google.clientKey === 'gone') {
    return { kind: 'key-gone', actions: [{ id: 'make-new-key' }, { id: 'start-over' }] }
  }
  const keyProjectId = google.client.projectId
  if (keyProjectId && run.projectId && keyProjectId !== run.projectId) {
    return {
      kind: 'key-other-project',
      keyProjectId,
      projectId: run.projectId,
      actions: [{ id: 'import-key' }, { id: 'make-new-key' }]
    }
  }
  return null
}

/** Why the saved key isn't this setup's, or null when it is. */
export const googleSetupKeyBlocker = keyBlocker

function accountBlocker(run: GoogleSetupRun, google: SetupGoogle): GoogleSetupBlocker | null {
  const account = googleSetupAccount(run, google.accounts)
  if (!account) {
    // Signed in, but not as the account the setup was for.
    const other = google.accounts.find((entry) => entry.connectedAt >= run.startedAt)
    if (other && run.account) {
      return {
        kind: 'other-account',
        signedIn: other.email,
        wanted: run.account,
        actions: [
          { id: 'keep-account', email: other.email },
          { id: 'sign-in-again', email: run.account }
        ]
      }
    }
    return null
  }
  if (account.status === 'reconnect') {
    return {
      kind: 'signed-out',
      email: account.email,
      actions: [{ id: 'sign-in-again', email: account.email }]
    }
  }
  const unallowed = choicesIn(run, account, 'needs-permission')
  if (unallowed.length > 0) {
    return {
      kind: 'needs-permission',
      services: unallowed,
      // Going on without them needs at least one chosen service left to use.
      actions: [
        { id: 'allow', services: unallowed },
        ...(unallowed.length < (run.services ?? []).length
          ? [{ id: 'continue-without' as const, services: unallowed }]
          : [])
      ]
    }
  }
  const off = choicesIn(run, account, 'api-disabled')
  // Orca never hears Google's switch flip or an admin's approval, so each fix comes with Check again.
  const recheck = { id: 'check-again' } as const
  if (off.length > 0) {
    return { kind: 'api-off', services: off, actions: [{ id: 'turn-on', services: off }, recheck] }
  }
  const blocked = choicesIn(run, account, 'blocked-by-admin')
  if (blocked.length > 0) {
    return {
      kind: 'admin-blocked',
      services: blocked,
      actions: [{ id: 'copy-for-admin' }, recheck]
    }
  }
  const failed = choicesIn(run, account, 'error')
  if (failed.length > 0) {
    return { kind: 'check-failed', services: failed, actions: [{ id: 'check-again' }] }
  }
  return null
}

/** Where the setup is stuck and what the owner can press, or null while it is moving. */
export function googleSetupBlocker(input: GoogleSetupBlockerInput): GoogleSetupBlocker | null {
  const { run, google } = input
  if (!run) {
    return null
  }
  const current = currentGoogleSetupStep(run)
  if (run.state === 'failed') {
    return {
      kind: 'stopped',
      step: current,
      ...(run.lastError ? { reason: run.lastError } : {}),
      actions: [{ id: 'continue' }, { id: 'start-over' }]
    }
  }
  if (run.state !== 'running') {
    return null
  }
  // A key is due once client is done, or once Orca saw it fail to arrive.
  if (google && (finished(run, 'client') || run.keyMissed)) {
    const key = keyBlocker(run, google)
    if (key) {
      return key
    }
    if (run.steps.connect?.status === 'done') {
      const account = accountBlocker(run, google)
      if (account) {
        return account
      }
    }
  }
  const handed = GOOGLE_SETUP_STEPS.find((step) => run.steps[step]?.status === 'needs-user')
  if (handed) {
    const note = run.steps[handed]?.note
    return {
      kind: 'needs-user',
      step: handed,
      ...(note ? { note } : {}),
      actions: [{ id: 'done', step: handed }]
    }
  }
  if (
    input.botTurnRunning === false &&
    current !== null &&
    current !== 'connect' &&
    !personDoesGoogleSetupStep(run, current) &&
    input.now - run.updatedAt >= GOOGLE_SETUP_PAUSED_AFTER_MS
  ) {
    return {
      kind: 'paused',
      step: current,
      actions: [{ id: 'continue' }, { id: 'let-me', step: current }]
    }
  }
  return null
}

/** Why the bot can't finish the setup yet, or null when every chosen service is ready. */
export function googleSetupDoneRefusal(
  run: GoogleSetupRun,
  google: Pick<GoogleStatusView, 'client' | 'accounts' | 'clientKey'>
): string | null {
  // Without the bot's turn there is no Paused: the bot asking is plainly running.
  const blocker = googleSetupBlocker({ run, google, botTurnRunning: null, now: run.updatedAt })
  if (blocker) {
    return `${googleSetupBlockerLine(blocker)} Your owner's card shows: ${googleSetupActionsLine(blocker)}.`
  }
  const left = currentGoogleSetupStep(run)
  if (left === 'connect') {
    return "Your owner hasn't signed in with the new app yet. It finishes when they sign in on the Connect Google card."
  }
  if (left) {
    return `The ${left} step isn't finished yet.`
  }
  if (!googleSetupAccount(run, google.accounts)) {
    return 'No Google account is connected for this setup yet.'
  }
  return null
}

// English words for the CLI; the cards translate their own with these as defaults.
const CHOICE_WORDS: Record<GoogleServiceChoice, string> = {
  gmail: 'Gmail',
  calendar: 'Calendar',
  files: 'Drive, Docs and Sheets'
}

export function googleSetupChoicesWords(choices: readonly GoogleServiceChoice[]): string {
  const words = choices.map((choice) => CHOICE_WORDS[choice])
  if (words.length <= 1) {
    return words[0] ?? ''
  }
  return `${words.slice(0, -1).join(', ')}${words.length > 2 ? ',' : ''} and ${words.at(-1)}`
}

/** Allow names the services when they fit on a button. */
export const GOOGLE_SETUP_ALLOW_NAMES_UP_TO = 2

export function googleSetupActionLabel(action: GoogleSetupAction): string {
  switch (action.id) {
    case 'make-new-key':
      return 'Make a new key'
    case 'import-key':
      return 'Import a key file'
    case 'allow':
      return action.services.length <= GOOGLE_SETUP_ALLOW_NAMES_UP_TO
        ? `Allow ${googleSetupChoicesWords(action.services)}`
        : 'Sign in again'
    case 'continue-without':
      return 'Continue without them'
    case 'keep-account':
      return `Keep ${action.email}`
    case 'sign-in-again':
      return action.email ? `Sign in as ${action.email}` : 'Sign in again'
    case 'turn-on':
      return 'Turn on'
    case 'copy-for-admin':
      return 'Copy for your admin'
    case 'check-again':
      return 'Check again'
    case 'continue':
      return 'Continue'
    case 'start-over':
      return 'Start over'
    case 'let-me':
      return 'Let me do this one'
    case 'done':
      return 'Done'
  }
}

export function googleSetupActionsLine(blocker: GoogleSetupBlocker): string {
  return blocker.actions.map(googleSetupActionLabel).join(' · ')
}

/** One line on what's true now, in the owner's words. */
export function googleSetupBlockerLine(blocker: GoogleSetupBlocker): string {
  switch (blocker.kind) {
    case 'stopped':
      return blocker.reason ? `Setup stopped: ${blocker.reason}` : 'Setup stopped.'
    case 'paused':
      return `The setup paused at ${blocker.step}. Everything so far is saved.`
    case 'needs-user':
      return blocker.note ?? `Your owner's turn: ${blocker.step}.`
    case 'no-key':
      return "Orca needs the app's key first."
    case 'key-gone':
      return "This app's key no longer works: it was removed in Google Cloud."
    case 'key-other-project':
      return `The saved key is for project ${blocker.keyProjectId}, not ${blocker.projectId}.`
    case 'other-account':
      return `Your owner signed in as ${blocker.signedIn}; this setup was for ${blocker.wanted}.`
    case 'signed-out':
      return `The sign-in for ${blocker.email} ended.`
    case 'needs-permission':
      return `Almost there: allow ${googleSetupChoicesWords(blocker.services)}. Google shows a box for each one; tick them all.`
    case 'api-off':
      return `${googleSetupChoicesWords(blocker.services)} is turned off in Google Cloud.`
    case 'admin-blocked':
      return `The company's Google admin blocked ${googleSetupChoicesWords(blocker.services)}.`
    case 'check-failed':
      return `Orca couldn't check ${googleSetupChoicesWords(blocker.services)}.`
  }
}

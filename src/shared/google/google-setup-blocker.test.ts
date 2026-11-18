import { describe, expect, it } from 'vitest'
import type { GoogleClientView } from './google-client-config'
import type { GoogleAccountView, GoogleServiceState } from './google-connect-types'
import {
  googleSetupActionsLine,
  type GoogleSetupBlocker,
  googleSetupBlocker,
  googleSetupBlockerLine,
  googleSetupDoneRefusal,
  GOOGLE_SETUP_PAUSED_AFTER_MS
} from './google-setup-blocker'
import type { GoogleSetupRun } from './google-setup-run'

const keyDone = { status: 'done' as const, at: 2 }

function run(overrides: Partial<GoogleSetupRun> = {}): GoogleSetupRun {
  return {
    id: 'run-1',
    botId: 'ivy',
    state: 'running',
    mode: 'do-it-for-me',
    steps: {},
    answers: {},
    account: 'you@gmail.com',
    kind: 'personal',
    services: ['gmail', 'calendar', 'files'],
    projectId: 'orca-ivy',
    startedAt: 1,
    updatedAt: 1,
    revision: 1,
    ...overrides
  }
}

/** Every step through the key done, and the owner signed in. */
const signedIn = (overrides: Partial<GoogleSetupRun> = {}) =>
  run({
    steps: {
      account: keyDone,
      project: keyDone,
      apis: keyDone,
      branding: keyDone,
      links: keyDone,
      publish: keyDone,
      client: keyDone,
      connect: keyDone
    },
    ...overrides
  })

function account(
  states: Partial<Record<string, GoogleServiceState>> = {},
  email = 'you@gmail.com'
): GoogleAccountView {
  return {
    email,
    status: 'connected',
    connectedAt: 5,
    services: (['gmail', 'calendar', 'drive', 'docs', 'sheets', 'contacts'] as const).map(
      (service) => ({ service, state: states[service] ?? 'ready' })
    )
  }
}

const client: GoogleClientView = {
  clientId: 'x.apps.googleusercontent.com',
  projectId: 'orca-ivy',
  source: 'imported',
  savedAt: 1
}

const actions = (value: GoogleSetupBlocker | null) => (value ? googleSetupActionsLine(value) : null)

function blocker(
  value: GoogleSetupRun,
  google: {
    client: GoogleClientView | null
    accounts: GoogleAccountView[]
    clientKey?: 'works' | 'gone' | 'unknown'
  } | null,
  extra: { botTurnRunning?: boolean | null; now?: number } = {}
) {
  return googleSetupBlocker({
    run: value,
    google,
    botTurnRunning: extra.botTurnRunning ?? true,
    now: extra.now ?? 2
  })
}

describe('where a Google setup is stuck', () => {
  it('asks for the key before the sign-in when none was saved', () => {
    const stuck = blocker(run({ steps: { client: keyDone } }), { client: null, accounts: [] })
    expect(stuck?.kind).toBe('no-key')
    expect(actions(stuck)).toBe('Make a new key · Import a key file')
  })

  it('says when the saved key is from another project', () => {
    const stuck = blocker(run({ steps: { client: keyDone } }), {
      client: { ...client, projectId: 'orca-old' },
      accounts: []
    })
    expect(stuck).toMatchObject({ kind: 'key-other-project', keyProjectId: 'orca-old' })
  })

  it('offers a new key once Google no longer knows the saved one', () => {
    const stuck = blocker(run({ steps: { client: keyDone } }), {
      client,
      clientKey: 'gone',
      accounts: []
    })
    expect(stuck?.kind).toBe('key-gone')
    expect(actions(stuck)).toBe('Make a new key · Start over')
    expect(
      blocker(run({ steps: { client: keyDone } }), { client, clientKey: 'unknown', accounts: [] })
    ).toBeNull()
  })

  it('offers Check again after Turn on or the admin request, since Orca never hears either fix', () => {
    const stuck = blocker(signedIn(), { client, accounts: [account({ calendar: 'api-disabled' })] })
    expect(stuck).toMatchObject({ kind: 'api-off', services: ['calendar'] })
    expect(actions(stuck)).toBe('Turn on · Check again')
    const blocked = blocker(signedIn(), {
      client,
      accounts: [account({ calendar: 'blocked-by-admin' })]
    })
    expect(actions(blocked)).toBe('Copy for your admin · Check again')
  })

  it('names the services left to allow, with Continue without them as the fallback', () => {
    const stuck = blocker(signedIn(), {
      client,
      accounts: [account({ gmail: 'needs-permission', calendar: 'needs-permission' })]
    })
    expect(stuck).toMatchObject({ kind: 'needs-permission', services: ['gmail', 'calendar'] })
    expect(actions(stuck)).toBe('Allow Gmail and Calendar · Continue without them')
    // More than fits on a button reads Sign in again.
    const all = blocker(signedIn(), {
      client,
      accounts: [
        account({
          gmail: 'needs-permission',
          calendar: 'needs-permission',
          docs: 'needs-permission'
        })
      ]
    })
    // Every chosen service needs allowing: going on without them would leave nothing to use.
    expect(actions(all)).toBe('Sign in again')
  })

  it('ignores a service the setup did not choose', () => {
    expect(
      blocker(signedIn({ services: ['gmail'] }), {
        client,
        accounts: [account({ calendar: 'needs-permission' })]
      })
    ).toBeNull()
  })

  it('offers to keep another account the owner signed in with', () => {
    const stuck = blocker(signedIn(), { client, accounts: [account({}, 'other@gmail.com')] })
    expect(stuck).toMatchObject({ kind: 'other-account', signedIn: 'other@gmail.com' })
    expect(actions(stuck)).toBe('Keep other@gmail.com · Sign in as you@gmail.com')
  })

  it('shows a stopped setup with Continue and Start over', () => {
    const stuck = blocker(run({ state: 'failed', lastError: 'No room for another project' }), null)
    expect(stuck && googleSetupBlockerLine(stuck)).toBe(
      'Setup stopped: No room for another project'
    )
    expect(actions(stuck)).toBe('Continue · Start over')
  })

  it('pauses a bot step only once its turn has ended for a while', () => {
    const quiet = { botTurnRunning: false, now: 1 + GOOGLE_SETUP_PAUSED_AFTER_MS }
    expect(blocker(run(), null, quiet)).toMatchObject({ kind: 'paused', step: 'account' })
    expect(blocker(run(), null, { ...quiet, now: 2 })).toBeNull()
    expect(blocker(run(), null, { ...quiet, botTurnRunning: null })).toBeNull()
    // The person's own steps never pause: the bot waits on them.
    expect(blocker(run({ mode: 'guide-here' }), null, quiet)).toBeNull()
  })

  it('points at a step handed to the owner', () => {
    expect(
      blocker(
        run({ steps: { branding: { status: 'needs-user', at: 2, note: 'Tick the box' } } }),
        null
      )
    ).toMatchObject({ kind: 'needs-user', step: 'branding', note: 'Tick the box' })
  })
})

const { publish: _publish, ...unpublished } = signedIn().steps
const { connect: _connect, ...unsigned } = signedIn().steps

describe("the bot's done", () => {
  it('stands once every chosen service is ready', () => {
    expect(googleSetupDoneRefusal(signedIn(), { client, accounts: [account()] })).toBeNull()
  })

  it('stands for an imported app, which names no account', () => {
    const imported = signedIn({
      account: undefined,
      answers: { path: { values: ['import'], at: 2 } }
    })
    expect(
      googleSetupDoneRefusal(imported, { client, accounts: [account({}, 'any@acme.com')] })
    ).toBeNull()
  })

  it("is refused with what is left and the owner's buttons", () => {
    expect(
      googleSetupDoneRefusal(signedIn(), {
        client,
        accounts: [account({ drive: 'needs-permission' })]
      })
    ).toBe(
      "Almost there: allow Drive, Docs and Sheets. Google shows a box for each one; tick them all. Your owner's card shows: Allow Drive, Docs and Sheets · Continue without them."
    )
    expect(
      googleSetupDoneRefusal(signedIn({ steps: unsigned }), { client, accounts: [] })
    ).toContain("hasn't signed in")
    expect(
      googleSetupDoneRefusal(signedIn({ steps: unpublished }), {
        client,
        accounts: [account()]
      })
    ).toContain('publish')
  })
})

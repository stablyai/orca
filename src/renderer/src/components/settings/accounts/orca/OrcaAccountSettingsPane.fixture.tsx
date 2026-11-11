import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type {
  OrcaCloudSignInEnd,
  OrcaCloudSignInProgress,
  OrcaProfileAuthStatus
} from '../../../../../../shared/orca-profiles'
import { OrcaAccountSettingsPane } from './OrcaAccountSettingsPane'

const width = 760

function pane(
  status: OrcaProfileAuthStatus,
  signIn: {
    progress?: OrcaCloudSignInProgress | null
    end?: OrcaCloudSignInEnd | null
  } = {}
) {
  return defineFixture({
    width,
    store: {
      orcaProfileAuthStatus: status,
      orcaProfileSignInProgress: signIn.progress ?? null,
      orcaProfileSignInEnd: signIn.end ?? null
    },
    // The pane re-reads auth status on mount; answer with the same state so the frame holds it.
    setup: () => {
      Object.assign(window.api.orcaProfiles, { authStatus: () => Promise.resolve(status) })
    },
    render: () => <OrcaAccountSettingsPane />
  })
}

/** Signed out: the status line names Orca Cloud, Artifacts and Orca Relay. */
export const signedOut = pane({
  activeProfileId: 'default',
  configured: true,
  state: 'local',
  persistence: 'none'
})

/** The session expired: the status line says so and points back at Orca Cloud. */
export const reconnectRequired = pane({
  activeProfileId: 'default',
  configured: true,
  state: 'reconnect-required',
  persistence: 'encrypted'
})

const signedOutStatus: OrcaProfileAuthStatus = {
  activeProfileId: 'default',
  configured: true,
  state: 'local',
  persistence: 'none'
}

/** Waiting on the browser: the primary stays live as "Reopen browser"; the line offers Cancel. */
export const signInPending = pane(signedOutStatus, {
  progress: { link: 'https://auth.example/v1/desktop/auth/authorize?state=preview' }
})

/** The browser never came back: a calm inline note, and Sign in to Orca again. */
export const signInTimedOut = pane(signedOutStatus, { end: 'timed-out' })

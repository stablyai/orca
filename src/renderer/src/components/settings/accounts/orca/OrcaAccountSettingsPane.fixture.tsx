import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { OrcaProfileAuthStatus } from '../../../../../../shared/orca-profiles'
import { OrcaAccountSettingsPane } from './OrcaAccountSettingsPane'

const width = 760

function pane(status: OrcaProfileAuthStatus) {
  return defineFixture({
    width,
    store: { orcaProfileAuthStatus: status },
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

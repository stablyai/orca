import type { GoogleSetupRun } from '../../../../../../shared/google/google-setup-run'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { ConfirmationDialogProvider } from '../../../dismiss/confirmation/confirmation-dialog'
import { GoogleSetupPathCard, GoogleSetupServicesCard } from './GoogleSetupChoiceCards'

// No Google app on this computer yet: the setup starts with the path card.
const run: GoogleSetupRun = {
  id: 'run-1',
  botId: 'ivy',
  state: 'running',
  mode: 'unchosen',
  steps: {},
  answers: {},
  startedAt: 1,
  updatedAt: 1,
  revision: 1
}

export const pathCard = defineFixture({
  width: 640,
  render: () => (
    <ConfirmationDialogProvider>
      <div className="p-4">
        <GoogleSetupPathCard bot={{ hostId: 'local', id: 'ivy' }} botName="Ivy" run={run} />
      </div>
    </ConfirmationDialogProvider>
  )
})

// The services card on a host that signs in read-only too: the owner picks the access level here.
export const servicesCard = defineFixture({
  width: 640,
  setup: () => {
    const runtime: unknown = window.api.runtime
    const status = { client: null, accounts: [], bots: [], accessLevels: ['full', 'read-draft'] }
    Reflect.set(window.api, 'runtime', {
      ...(typeof runtime === 'object' ? runtime : {}),
      call: async ({ method }: { method: string }) =>
        method === 'google.status'
          ? { ok: true, result: status }
          : { ok: false, error: { code: 'runtime_error', message: 'not in this fixture' } }
    })
  },
  render: () => (
    <ConfirmationDialogProvider>
      <div className="p-4">
        <GoogleSetupServicesCard bot={{ hostId: 'local', id: 'ivy' }} run={run} />
      </div>
    </ConfirmationDialogProvider>
  )
})

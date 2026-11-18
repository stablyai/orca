import type { GoogleSetupRun } from '../../../../../../shared/google/google-setup-run'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { ConfirmationDialogProvider } from '../../../dismiss/confirmation/confirmation-dialog'
import { GoogleSetupPathCard } from './GoogleSetupChoiceCards'

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

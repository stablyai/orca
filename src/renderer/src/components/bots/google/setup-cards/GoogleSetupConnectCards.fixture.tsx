import type { GoogleSetupRun } from '../../../../../../shared/google/google-setup-run'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { ConfirmationDialogProvider } from '../../../dismiss/confirmation/confirmation-dialog'
import { GoogleSetupConnectCard } from './GoogleSetupConnectCards'

const run: GoogleSetupRun = {
  id: 'run-1',
  botId: 'ivy',
  state: 'running',
  mode: 'do-it-for-me',
  kind: 'personal',
  account: 'owner@gmail.com',
  services: ['gmail', 'calendar'],
  steps: { client: { status: 'done', at: 2, by: 'bot' } },
  answers: {},
  startedAt: 1,
  updatedAt: 2,
  revision: 3
}

const chatter = (
  <div className="my-3 space-y-2 text-sm text-muted-foreground">
    <p>The key is in Orca. Your sign-in is the last step.</p>
    <p>…the conversation carries on here…</p>
  </div>
)

/** Before: the card stays where it was written, screens up the chat. */
export const writtenOnce = defineFixture({
  width: 420,
  render: () => (
    <ConfirmationDialogProvider>
      <GoogleSetupConnectCard
        bot={{ hostId: 'local', id: 'ivy', name: 'Ivy', members: [] }}
        run={run}
        newest
      />
      {chatter}
    </ConfirmationDialogProvider>
  )
})

/** After: when sign-in waits, Orca writes it again at the bottom; the older copy points down. */
export const writtenAgain = defineFixture({
  width: 420,
  render: () => (
    <ConfirmationDialogProvider>
      <GoogleSetupConnectCard
        bot={{ hostId: 'local', id: 'ivy', name: 'Ivy', members: [] }}
        run={run}
        newest={false}
      />
      {chatter}
      <GoogleSetupConnectCard
        bot={{ hostId: 'local', id: 'ivy', name: 'Ivy', members: [] }}
        run={run}
        newest
      />
    </ConfirmationDialogProvider>
  )
})

import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { WorkerTabsFixtureStrip } from './worker-tabs-fixture-scene'
import { seed } from './worker-tabs-fixture-data'

export const normal = defineFixture({
  width: 1280,
  store: seed,
  render: () => (
    <ConfirmationDialogProvider>
      <WorkerTabsFixtureStrip />
    </ConfirmationDialogProvider>
  )
})
export const narrow = defineFixture({
  width: 400,
  store: seed,
  render: () => (
    <ConfirmationDialogProvider>
      <WorkerTabsFixtureStrip />
    </ConfirmationDialogProvider>
  )
})

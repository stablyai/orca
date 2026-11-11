// JA-33: sign-out names what matters, cloud workspaces.
import { defineFixture } from '../../component-fixtures/component-fixture'
import { OrcaProfileSignOutConfirmDialog } from './OrcaProfileSignOutConfirmDialog'

export const open = defineFixture({
  width: 520,
  render: () => (
    <OrcaProfileSignOutConfirmDialog
      open
      onOpenChange={() => {}}
      onConfirm={() => {}}
      signingOut={false}
    />
  )
})

import { defineFixture } from '../../component-fixtures/component-fixture'
import { AddProjectMenu } from '@/components/sidebar/project-admission/menu/AddProjectMenu'
import { withCloudAddProjectEntry } from './ProjectComboboxCloudAddProjectEntry'

const noop = (): void => {}

const { addProjectMenu } = withCloudAddProjectEntry(
  { defaultHostId: null, onOpenEntryRequest: noop, onOpenRemoteHostDialog: noop },
  noop
)

/** PROJ-MENU part 2: the Add project menu with "From GitHub (Orca Cloud)…" as its last entry. */
export const addProjectMenuWithCloud = defineFixture({
  width: 520,
  render: () => (
    <div className="h-[260px] bg-background p-4">
      <AddProjectMenu
        open
        side="bottom"
        align="start"
        autoFocusFirstItem={false}
        onOpenEntryRequest={noop}
        onOpenRemoteHostDialog={noop}
        extraItems={addProjectMenu?.extraItems}
      >
        <button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm">
          Add project
        </button>
      </AddProjectMenu>
    </div>
  )
})

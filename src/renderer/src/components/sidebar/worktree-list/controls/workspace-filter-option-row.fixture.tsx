import { defineFixture } from '@/component-fixtures/component-fixture'
import { WorkspaceFilterOptionRow } from './workspace-filter-option-row'

function FilterRow(): React.JSX.Element {
  return (
    <div className="w-64 bg-popover p-2 text-foreground">
      <WorkspaceFilterOptionRow optionKey="hideDoneWorkspaces" />
    </div>
  )
}

export const hideDoneOff = defineFixture({ width: 280, render: () => <FilterRow /> })

export const hideDoneOn = defineFixture({
  width: 280,
  store: { hideDoneWorkspaces: true },
  render: () => <FilterRow />
})

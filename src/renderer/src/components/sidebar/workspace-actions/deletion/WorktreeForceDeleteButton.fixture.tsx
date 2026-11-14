import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { WorktreeForceDeleteButton } from './WorktreeForceDeleteButton'

export const workspaceScope = defineFixture({
  width: 360,
  render: () => (
    <div className="flex h-40 items-end justify-end p-3">
      <WorktreeForceDeleteButton onForceDelete={() => {}} onAlwaysForceDelete={async () => {}} />
    </div>
  ),
  interact: (frame) => {
    frame
      .querySelector<HTMLButtonElement>('[data-slot="dropdown-menu-trigger"]')
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  }
})

export const preservedBranchScope = defineFixture({
  ...workspaceScope,
  render: () => (
    <div className="flex h-40 items-end justify-end p-3">
      <WorktreeForceDeleteButton
        onForceDelete={() => {}}
        onAlwaysForceDelete={async () => {}}
        alwaysForceDeleteLabel="Always delete preserved branches"
        alwaysForceDeleteDescription="Applies to branches kept after future workspace deletions."
      />
    </div>
  )
})

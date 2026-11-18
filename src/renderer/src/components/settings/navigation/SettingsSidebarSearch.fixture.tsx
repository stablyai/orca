import { defineFixture } from '../../../component-fixtures/component-fixture'
import { SettingsSearchField } from './SettingsSidebarSearch'

// Settings opens with this field autofocused when no section is targeted.
export const autoFocused = defineFixture({
  width: 280,
  render: () => (
    <div className="bg-worktree-sidebar">
      <SettingsSearchField
        searchAutoFocus
        query=""
        listboxId="settings-search-results"
        expanded={false}
        activeOptionId={undefined}
        onQueryChange={() => {}}
        onKeyDown={() => {}}
      />
    </div>
  )
})

import { defineFixture } from '../../component-fixtures/component-fixture'
import { SidebarBotsEmptyState } from './SidebarBotsEmptyState'

export const empty = defineFixture({
  render: () => (
    <div className="w-[260px] bg-sidebar pt-2">
      <SidebarBotsEmptyState onNewBot={() => {}} />
    </div>
  )
})

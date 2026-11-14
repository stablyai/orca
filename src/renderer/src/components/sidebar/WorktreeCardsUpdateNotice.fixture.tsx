import { getDefaultSettings } from '../../../../shared/constants'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { WorktreeCardsUpdateNotice } from './WorktreeCardsUpdateNotice'

export const shown = defineFixture({
  width: 280,
  store: {
    settings: { ...getDefaultSettings('/home/fixture'), experimentalNewWorktreeCardStyle: true },
    worktreeCardsUpdateNoticeSeen: false
  },
  render: () => (
    <div className="bg-worktree-sidebar py-2">
      <WorktreeCardsUpdateNotice />
      <div className="mx-2 rounded-lg px-2.5 py-2 text-sm text-worktree-sidebar-foreground">
        release-train
      </div>
    </div>
  )
})

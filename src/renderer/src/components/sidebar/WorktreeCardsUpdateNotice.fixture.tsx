import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { WorktreeCardsUpdateNotice } from './WorktreeCardsUpdateNotice'

const store = {
  settings: { ...getDefaultSettings('/home/fixture'), experimentalNewWorktreeCardStyle: true },
  worktreeCardsUpdateNoticeSeen: false
}

const render = (): React.JSX.Element => (
  <div className="bg-worktree-sidebar py-2">
    <WorktreeCardsUpdateNotice />
    <div className="mx-2 rounded-lg px-2.5 py-2 text-sm text-worktree-sidebar-foreground">
      release-train
    </div>
  </div>
)

export const shown = defineFixture({ width: 280, store, render })

// The sidebar's narrowest width: the unread caption should still fit on one line.
export const narrow = defineFixture({ width: 220, store, render })

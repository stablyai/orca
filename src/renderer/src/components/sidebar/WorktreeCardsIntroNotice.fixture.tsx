import { getDefaultSettings } from '../../../../shared/constants'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { WorktreeCardsIntroNotice } from './WorktreeCardsIntroNotice'
import SidebarWorkspaceOptionsMenu from './worktree-list/controls/SidebarWorkspaceOptionsMenu'

const settings = { ...getDefaultSettings('/home/fixture'), experimentalNewWorktreeCardStyle: false }

const render = (): React.JSX.Element => (
  <div className="bg-worktree-sidebar py-2">
    <WorktreeCardsIntroNotice />
    <div className="mx-2 rounded-lg px-2.5 py-2 text-sm text-worktree-sidebar-foreground">
      release-train
    </div>
  </div>
)

// The note opens on New, so the list below is already a preview.
export const previewing = defineFixture({
  width: 280,
  store: { settings, worktreeCardsIntroNoticeSeen: true, worktreeCardsIntroChoice: 'new' },
  render
})

export const flippedToClassic = defineFixture({
  width: 280,
  store: { settings, worktreeCardsIntroNoticeSeen: true, worktreeCardsIntroChoice: 'classic' },
  render
})

// The sidebar's narrowest width: "Keep new" should stay on one line beside the switch.
export const narrow = defineFixture({
  width: 220,
  store: { settings, worktreeCardsIntroNoticeSeen: true, worktreeCardsIntroChoice: 'new' },
  render
})

// After Keep: the pointer under Workspace options.
export const keptHint = defineFixture({
  width: 280,
  store: {
    settings: { ...settings, experimentalNewWorktreeCardStyle: true },
    worktreeCardsIntroKeptHintOpen: true
  },
  render: () => (
    <div className="flex h-28 items-start justify-end bg-worktree-sidebar p-2">
      <SidebarWorkspaceOptionsMenu />
    </div>
  )
})

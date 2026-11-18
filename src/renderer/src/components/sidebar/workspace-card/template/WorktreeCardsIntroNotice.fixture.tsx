import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { WorktreeCardsIntroNotice } from './WorktreeCardsIntroNotice'
import SidebarWorkspaceOptionsMenu from '../../worktree-list/controls/SidebarWorkspaceOptionsMenu'

const settings = { ...getDefaultSettings('/home/fixture'), experimentalNewWorktreeCardStyle: false }

// The note floats right of a sidebar strip, over the main area.
const render = (): React.JSX.Element => (
  <div className="flex h-[380px]">
    <div className="flex w-[240px] flex-col bg-worktree-sidebar py-2">
      <WorktreeCardsIntroNotice />
      <div className="mx-2 rounded-lg px-2.5 py-2 text-sm text-worktree-sidebar-foreground">
        release-train
      </div>
    </div>
  </div>
)

// The note opens on New, so the list beside it is already a preview.
export const previewing = defineFixture({
  width: 660,
  store: { settings, worktreeCardsIntroNoticeSeen: true, worktreeCardsIntroChoice: 'new' },
  render
})

export const flippedToClassic = defineFixture({
  width: 660,
  store: { settings, worktreeCardsIntroNoticeSeen: true, worktreeCardsIntroChoice: 'classic' },
  render
})

// Too little room beside the sidebar: the note drops under the first row instead of clipping.
export const narrow = defineFixture({
  width: 420,
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

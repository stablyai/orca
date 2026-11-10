import { defineFixture } from '../../component-fixtures/component-fixture'
import { Command, CommandList } from '../ui/command'
import { WorktreeJumpPaletteActionRow } from '../worktree-jump/worktree-jump-palette-project-action-rows'
import type { WorktreeJumpPaletteController } from '../worktree-jump/use-worktree-jump-palette-controller'
import type { QuickActionPaletteItem } from '../worktree-jump/worktree-jump-palette-model'
import { getRemoteDesktopQuickAction } from './remote-desktop-quick-action'

const controller = { handleSelectItem: () => {} } as unknown as WorktreeJumpPaletteController

/** "Open remote desktop" in the palette while an Orca Cloud workspace is active (hidden otherwise). */
export const paletteRow = defineFixture({
  width: 560,
  render: () => {
    const entry: QuickActionPaletteItem = {
      id: 'quick-action:open-cloud-remote-desktop',
      type: 'quick-action',
      result: { ...getRemoteDesktopQuickAction(), order: 0, qualityClass: 'visible-prefix' }
    }
    return (
      <div className="bg-background p-2">
        <Command value={entry.id} className="rounded-lg border border-border bg-popover">
          <CommandList className="p-1">
            <WorktreeJumpPaletteActionRow
              entry={entry}
              renderKey={entry.id}
              controller={controller}
            />
          </CommandList>
        </Command>
      </div>
    )
  }
})

import { PanelsTopLeft } from 'lucide-react'
import { CommandItem } from './ui/command'
import { Button } from './ui/button'
import type { WorkspaceViewPaletteItem } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'

export function WorktreeJumpPaletteViewRow({
  entry,
  renderKey,
  controller
}: {
  entry: WorkspaceViewPaletteItem
  renderKey: string
  controller: WorktreeJumpPaletteController
}) {
  const placement = entry.placement
  return (
    <CommandItem
      value={renderKey}
      onSelect={() => controller.handleSelectItem(entry)}
      className="jump-palette-item mx-0.5 gap-3 px-3 py-2"
    >
      <PanelsTopLeft className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{placement.view.label}</div>
        <div className="truncate text-xs text-muted-foreground">
          {placement.projectName} / {placement.workspace} · {placement.hostName}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {placement.windowTitle}
          {placement.windowId !== 0 && ` (${placement.windowId})`} · Pane {placement.paneNumber}
          {placement.availability && ` · ${placement.availability}`}
        </div>
      </div>
      {(['here', 'beside'] as const).map((action) => (
        <Button
          key={action}
          size="xs"
          variant="ghost"
          disabled={!!placement.availability}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            void controller.handleSelectPlacement(entry, action)
          }}
        >
          {action === 'here' ? 'Open Here' : 'Open Beside'}
        </Button>
      ))}
    </CommandItem>
  )
}

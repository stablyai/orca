import { PanelsTopLeft } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { WorkspaceMultiplexerPicker } from './WorkspaceMultiplexerPicker'
import type { WorkspaceMultiplexerCatalogItem } from './workspace-multiplexer-model'

export function WorkspaceMultiplexerEmptyState({
  items,
  slotCountByIdentity,
  terminalCountByIdentity,
  onSelect,
  onWorkspaceDragStart,
  onWorkspaceDragEnd
}: {
  items: readonly WorkspaceMultiplexerCatalogItem[]
  slotCountByIdentity: ReadonlyMap<string, number>
  terminalCountByIdentity: ReadonlyMap<string, number>
  onSelect: (item: WorkspaceMultiplexerCatalogItem) => void
  onWorkspaceDragStart: (item: WorkspaceMultiplexerCatalogItem) => void
  onWorkspaceDragEnd: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-xl border border-border bg-muted/30">
        <PanelsTopLeft className="size-6 text-muted-foreground" />
      </div>
      <div>
        <h2 className="text-base font-semibold text-foreground">
          {translate(
            'auto.components.workspace.multiplexer.WorkspaceMultiplexerPage.emptyTitle',
            'Keep running work in sight'
          )}
        </h2>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          {translate(
            'auto.components.workspace.multiplexer.WorkspaceMultiplexerPage.emptyDescription',
            'Add the worktrees and folders you move between to watch their terminals together. Orca restores the layout after restart.'
          )}
        </p>
      </div>
      <WorkspaceMultiplexerPicker
        items={items}
        slotCountByIdentity={slotCountByIdentity}
        terminalCountByIdentity={terminalCountByIdentity}
        onSelect={onSelect}
        onWorkspaceDragStart={onWorkspaceDragStart}
        onWorkspaceDragEnd={onWorkspaceDragEnd}
      />
    </div>
  )
}

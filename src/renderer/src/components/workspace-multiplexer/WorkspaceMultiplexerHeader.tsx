import { ArrowLeft, PanelsTopLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { WorkspaceMultiplexerPicker } from './WorkspaceMultiplexerPicker'
import { WorkspaceMultiplexerSwitcher } from './WorkspaceMultiplexerSwitcher'
import type { WorkspaceMultiplexerCatalogItem } from './workspace-multiplexer-model'

export function WorkspaceMultiplexerHeader({
  items,
  slotCountByIdentity,
  terminalCountByIdentity,
  onBack,
  onSelect,
  onWorkspaceDragStart,
  onWorkspaceDragEnd,
  isDragOver
}: {
  items: readonly WorkspaceMultiplexerCatalogItem[]
  slotCountByIdentity: ReadonlyMap<string, number>
  terminalCountByIdentity: ReadonlyMap<string, number>
  onBack: () => void
  onSelect: (item: WorkspaceMultiplexerCatalogItem) => void
  onWorkspaceDragStart: (item: WorkspaceMultiplexerCatalogItem) => void
  onWorkspaceDragEnd: () => void
  isDragOver: boolean
}): React.JSX.Element {
  return (
    <header className="relative flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
      <Button variant="outline" size="sm" onClick={onBack} className="shrink-0 gap-1.5">
        <ArrowLeft className="size-3.5" />
        {translate('auto.components.workspace.multiplexer.WorkspaceMultiplexerPage.back', 'Back')}
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <PanelsTopLeft className="size-3.5 shrink-0 text-muted-foreground" />
        <WorkspaceMultiplexerSwitcher />
      </div>
      <WorkspaceMultiplexerPicker
        items={items}
        slotCountByIdentity={slotCountByIdentity}
        terminalCountByIdentity={terminalCountByIdentity}
        onSelect={onSelect}
        onWorkspaceDragStart={onWorkspaceDragStart}
        onWorkspaceDragEnd={onWorkspaceDragEnd}
      />
      {isDragOver ? (
        <div className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 -translate-x-1/2 rounded-md border border-ring bg-popover px-3 py-1.5 text-xs font-medium text-popover-foreground shadow-sm">
          {translate(
            'auto.components.workspace.multiplexer.WorkspaceMultiplexerPage.dropToAdd',
            'Drop to add workspace'
          )}
        </div>
      ) : null}
    </header>
  )
}

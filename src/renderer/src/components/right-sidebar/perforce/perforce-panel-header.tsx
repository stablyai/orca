import { ArchiveRestore, ArrowDownToLine, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { PerforceWorkspaceInfo } from '../../../../../shared/perforce/perforce-types'

export function PerforcePanelHeader({
  info,
  busy,
  onRefresh,
  onSync,
  onUnshelve
}: {
  info: PerforceWorkspaceInfo
  busy: boolean
  onRefresh: () => void
  onSync: () => void
  onUnshelve: () => void
}) {
  const subtitle = [info.stream, info.haveChange ? `synced to @${info.haveChange}` : null]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium" title={info.root}>
          {info.client}
        </div>
        <div className="truncate text-xs text-muted-foreground">{subtitle || info.port}</div>
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        title="Unshelve a changelist…"
        disabled={busy}
        onClick={onUnshelve}
      >
        <ArchiveRestore />
      </Button>
      <Button variant="ghost" size="icon-xs" title="Refresh" disabled={busy} onClick={onRefresh}>
        <RefreshCw />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        title="Get latest revisions (p4 sync)"
        disabled={busy}
        onClick={onSync}
      >
        <ArrowDownToLine />
      </Button>
    </div>
  )
}

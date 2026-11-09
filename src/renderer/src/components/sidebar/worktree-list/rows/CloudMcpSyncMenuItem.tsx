import { Blocks } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useCloudMcpSyncStatus } from '@/lib/cloud-mcp-sync/cloud-mcp-sync-client'
import { mcpSyncSummary } from '../../../settings/runtime-environments/cloud-mcp/cloud-mcp-sync-copy'

/** "MCP servers · 3 synced" for an Orca Cloud workspace host; opens its section in Settings. */
export function CloudMcpSyncMenuItem({
  environmentId,
  open,
  onSelect
}: {
  environmentId: string
  open: boolean
  onSelect: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const status = useCloudMcpSyncStatus(environmentId, open)
  if (!status) {
    return null
  }
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <Blocks className="size-3.5" />
      <span className="flex-1 truncate">{t('cloudMcpSync.title', 'MCP servers')}</span>
      <span className="truncate text-2xs text-muted-foreground">{mcpSyncSummary(status, t)}</span>
    </DropdownMenuItem>
  )
}

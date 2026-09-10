import { Play, RefreshCw, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { translate } from '@/i18n/i18n'
import type { useDatabaseQuery } from './useDatabaseQuery'

export function DatabaseQueryToolbar({
  query
}: {
  query: ReturnType<typeof useDatabaseQuery>
}): React.JSX.Element {
  return (
    <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-border px-2 py-1">
      <Button size="xs" disabled={query.running} onClick={() => void query.run()}>
        <Play />
        {translate('auto.components.database.toolbar.run', 'Run')}
        <ShortcutKeyCombo keys={[navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl', 'Enter']} />
      </Button>
      <Button
        variant="outline"
        size="xs"
        disabled={!query.canRefresh || query.running}
        onClick={() => void query.run()}
      >
        <RefreshCw />
        {translate('auto.components.database.toolbar.refresh', 'Refresh results')}
      </Button>
      {query.running ? (
        <Button variant="ghost" size="xs" onClick={() => void query.cancel()}>
          <Square />
          {translate('auto.components.database.toolbar.cancel', 'Cancel')}
        </Button>
      ) : null}
      <Select
        value={String(query.refreshSeconds)}
        disabled={!query.canRefresh}
        onValueChange={(value) => query.setRefreshSeconds(Number(value))}
      >
        <SelectTrigger
          className="h-6 w-32 text-xs"
          aria-label={translate('auto.components.database.toolbar.autoRefresh', 'Auto-refresh')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="0">
            {translate('auto.components.database.toolbar.manualRefresh', 'Manual refresh')}
          </SelectItem>
          {[5, 10, 30, 60].map((seconds) => (
            <SelectItem key={seconds} value={String(seconds)}>
              {translate('auto.components.database.toolbar.refreshEvery', 'Every {{seconds}}s', {
                seconds
              })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {query.result && query.lastRun ? (
        <span className="ml-auto text-[11px] text-muted-foreground" role="status">
          {translate(
            'auto.components.database.toolbar.refreshed',
            '{{rows}} rows{{more}} · {{duration}} ms · Updated {{time}}',
            {
              rows: query.result.rows.length,
              more: query.result.truncated ? '+' : '',
              duration: query.result.durationMs,
              time: new Date(query.lastRun.at).toLocaleTimeString()
            }
          )}
        </span>
      ) : null}
    </div>
  )
}

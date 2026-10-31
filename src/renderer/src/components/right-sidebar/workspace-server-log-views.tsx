import React, { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { WorkspaceServerLaunch } from '@/lib/workspace-server-launches'
import type { WorkspaceServerSnapshot } from '../../../../shared/workspace-server-process'
import { WorkspaceServerLogPanel } from './workspace-server-log-panel'

type LogTabsProps = {
  entries: WorkspaceServerLaunch[]
  runs: WorkspaceServerSnapshot[]
  selected: string
  excluded?: string
  label: string
  onSelect: (id: string) => void
  onClose: () => void
}

function ServerLogTabs({
  entries,
  runs,
  selected,
  excluded,
  label,
  onSelect,
  onClose
}: LogTabsProps): React.JSX.Element {
  const [visited, setVisited] = useState(() => new Set([selected]))
  useEffect(() => {
    setVisited((current) => (current.has(selected) ? current : new Set(current).add(selected)))
  }, [selected])
  return (
    <Tabs
      value={selected}
      onValueChange={(id) => {
        setVisited((current) => new Set(current).add(id))
        onSelect(id)
      }}
      className="min-h-0 min-w-0 flex-1 gap-1"
    >
      <div className="shrink-0 overflow-x-auto scrollbar-sleek">
        <TabsList variant="line" size="sm" aria-label={label}>
          {entries.map((entry) => {
            const errors = runs.find((run) => run.port === entry.port)?.errorCount ?? 0
            const errorLabel = translate(
              'auto.components.right.sidebar.index.serverLogErrors',
              'Errors: {{count}}',
              { count: errors }
            )
            return (
              <TabsTrigger
                key={entry.id}
                value={entry.id}
                disabled={entry.id === excluded}
                aria-label={`${entry.name} :${entry.port}${errors ? ` · ${errorLabel}` : ''}`}
                className="max-w-48 flex-none"
              >
                <span className="truncate">{entry.name}</span>
                <span className="font-mono text-3xs text-muted-foreground">:{entry.port}</span>
                {errors > 0 && (
                  <span className="text-3xs text-destructive" aria-hidden="true">
                    {errors}
                  </span>
                )}
              </TabsTrigger>
            )
          })}
        </TabsList>
      </div>
      {entries.map((entry) => {
        if (!visited.has(entry.id) && entry.id !== selected) {
          return null
        }
        const visible = entry.id === selected
        return (
          <TabsContent
            key={entry.id}
            value={entry.id}
            forceMount
            hidden={!visible}
            className={cn('min-h-0', !visible && 'hidden')}
          >
            <WorkspaceServerLogPanel
              name={entry.name}
              run={runs.find((run) => run.port === entry.port)}
              visible={visible}
              className="h-full"
              onClose={onClose}
            />
          </TabsContent>
        )
      })}
    </Tabs>
  )
}

export function WorkspaceServerLogViews({
  entries,
  runs,
  selected,
  onSelect,
  onClose
}: Omit<LogTabsProps, 'label' | 'excluded'>): React.JSX.Element | null {
  const [split, setSplit] = useState(false)
  const [comparison, setComparison] = useState<string | null>(null)
  const primary = entries.find((entry) => entry.id === selected)
  const secondary =
    entries.find((entry) => entry.id === comparison && entry.id !== selected) ??
    entries.find((entry) => entry.id !== selected)
  if (!primary) {
    return null
  }
  const isSplit = split && Boolean(secondary)
  return (
    <section
      className="mx-3 my-2 min-w-0"
      aria-label={translate('auto.components.right.sidebar.index.serverLogViews', 'Server Logs')}
    >
      <div className="mb-1 flex items-center gap-1">
        <Button variant="ghost" size="xs" aria-pressed={!isSplit} onClick={() => setSplit(false)}>
          {translate('auto.components.right.sidebar.index.serverLogTabs', 'Tabs')}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          aria-pressed={isSplit}
          className={cn(isSplit && 'bg-accent text-accent-foreground')}
          disabled={!secondary}
          onClick={() => setSplit(true)}
        >
          {translate('auto.components.right.sidebar.index.serverLogSplit', 'Stacked Split')}
        </Button>
      </div>
      <div className={cn('flex min-w-0 flex-col', isSplit ? 'h-128 gap-2' : 'h-80')}>
        <ServerLogTabs
          entries={entries}
          runs={runs}
          selected={selected}
          label={translate('auto.components.right.sidebar.index.serverLogPrimary', 'Primary Logs')}
          onSelect={onSelect}
          onClose={onClose}
        />
        {isSplit && secondary && (
          <ServerLogTabs
            entries={entries}
            runs={runs}
            selected={secondary.id}
            excluded={selected}
            label={translate(
              'auto.components.right.sidebar.index.serverLogComparison',
              'Comparison Logs'
            )}
            onSelect={setComparison}
            onClose={() => setSplit(false)}
          />
        )}
      </div>
    </section>
  )
}

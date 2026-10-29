import { useMemo } from 'react'
import { VirtualizedList } from '@/components/virtualized-list'
import { translate } from '@/i18n/i18n'
import type { ResourcePtyGroup, ResourcePtyRow as PtyRow } from './resource-pty-view-model'
import { ResourcePtyRow } from './ResourcePtyRow'

type ListItem =
  | { kind: 'project'; key: string; name: string | null; count: number }
  | { kind: 'workspace'; key: string; name: string; count: number }
  | { kind: 'session'; key: string; row: PtyRow }

export function ResourcePtyList({
  groups,
  scrollElement,
  observedAt,
  unverifiable,
  ending,
  errors,
  onEnd,
  onNavigate
}: {
  groups: readonly ResourcePtyGroup[]
  scrollElement: HTMLDivElement | null
  observedAt: number | null
  unverifiable: boolean
  ending: ReadonlySet<string>
  errors: ReadonlyMap<string, string>
  onEnd: (row: PtyRow) => void
  onNavigate: (tabId: string, paneKey: string | null) => void
}) {
  const items = useMemo(() => {
    const result: ListItem[] = []
    for (const group of groups) {
      result.push({
        kind: 'project',
        key: JSON.stringify(['project', group.id]),
        name: group.name,
        count: group.workspaces.reduce((count, workspace) => count + workspace.rows.length, 0)
      })
      for (const workspace of group.workspaces) {
        if (workspace.name) {
          result.push({
            kind: 'workspace',
            key: JSON.stringify(['workspace', group.id, workspace.id]),
            name: workspace.name,
            count: workspace.rows.length
          })
        }
        for (const row of workspace.rows) {
          result.push({ kind: 'session', key: row.identity, row })
        }
      }
    }
    return result
  }, [groups])
  return (
    <VirtualizedList
      rows={items}
      getRowKey={(item) => item.key}
      scrollElement={scrollElement}
      estimateRowHeightPx={40}
      announceListPosition
      renderRow={(item) => {
        switch (item.kind) {
          case 'project':
            return (
              <h3
                key={item.key}
                className="flex justify-between px-3 pt-3 pb-1 text-2xs font-semibold uppercase tracking-wide"
              >
                <span>
                  {item.name ?? translate('resourceManager.pty.unassigned', 'Unassigned')}
                </span>
                <span>{item.count}</span>
              </h3>
            )
          case 'workspace':
            return (
              <div
                key={item.key}
                className="flex justify-between px-4 py-1 text-xs text-muted-foreground"
              >
                <span className="truncate">{item.name}</span>
                <span>{item.count}</span>
              </div>
            )
          case 'session':
            return (
              <ResourcePtyRow
                key={item.key}
                row={item.row}
                observedAt={observedAt}
                unverifiable={unverifiable}
                ending={!!item.row.session.exiting || ending.has(item.row.identity)}
                error={errors.get(item.row.identity)}
                onEnd={onEnd}
                onNavigate={onNavigate}
              />
            )
        }
      }}
    />
  )
}

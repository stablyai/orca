import type React from 'react'
import { VirtualizedList } from '@/components/ui/virtualized-list'
import type { ResourcePtyGroup, ResourcePtyRow as PtyRow } from './resource-pty-view-model'
import { ResourcePtyGroupRow } from './ResourcePtyGroupRow'
import { ResourcePtyRow } from './ResourcePtyRow'
import { canEndResourcePty } from './use-resource-pty-actions'

export type ResourcePtyListItem =
  | { kind: 'group'; key: string; group: ResourcePtyGroup; open: boolean }
  | { kind: 'session'; key: string; row: PtyRow; showWorkspace: boolean }

const itemKey = (item: ResourcePtyListItem): string => item.key

export function ResourcePtyList({
  items,
  scrollElement,
  observedAt,
  unverifiable,
  ending,
  errors,
  selected,
  openDetails,
  onToggleGroup,
  onEndAll,
  onActivate,
  onEnd,
  onNavigate
}: {
  items: readonly ResourcePtyListItem[]
  scrollElement: HTMLDivElement | null
  observedAt: number | null
  unverifiable: boolean
  ending: ReadonlySet<string>
  errors: ReadonlyMap<string, string>
  selected: ReadonlySet<string>
  openDetails: ReadonlySet<string>
  onToggleGroup: (key: string) => void
  onEndAll: (group: ResourcePtyGroup, source: Element) => void
  onActivate: (row: PtyRow, event: React.MouseEvent, canSelect: boolean) => void
  onEnd: (row: PtyRow) => void
  onNavigate: (tabId: string, paneKey: string | null) => void
}) {
  return (
    <VirtualizedList
      rows={items}
      getRowKey={itemKey}
      scrollElement={scrollElement}
      estimateRowHeightPx={26}
      announceListPosition
      renderRow={(item) =>
        item.kind === 'group' ? (
          <ResourcePtyGroupRow
            key={item.key}
            group={item.group}
            open={item.open}
            canEndAll={
              !unverifiable &&
              item.group.rows.some((row) => canEndResourcePty(row) && !ending.has(row.identity))
            }
            onToggle={onToggleGroup}
            onEndAll={onEndAll}
          />
        ) : (
          <ResourcePtyRow
            key={item.key}
            row={item.row}
            showWorkspace={item.showWorkspace}
            observedAt={observedAt}
            unverifiable={unverifiable}
            ending={!!item.row.session.exiting || ending.has(item.row.identity)}
            error={errors.get(item.row.identity)}
            selected={selected.has(item.row.identity)}
            detailsOpen={openDetails.has(item.row.identity)}
            onActivate={onActivate}
            onEnd={onEnd}
            onNavigate={onNavigate}
          />
        )
      }
    />
  )
}

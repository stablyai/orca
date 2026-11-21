import type React from 'react'
import { VirtualizedList } from '@/components/ui/virtualized-list'
import type { ResourcePtyGroup, ResourcePtyRow as PtyRow } from './resource-pty-view-model'
import { ResourcePtyGroupRow, ResourcePtyLabelContext } from './ResourcePtyGroupRow'
import { ResourcePtyRow } from './ResourcePtyRow'
import type { ResourcePtyActionStatus } from './resource-pty-action-status'
import type { useResourcePtyEndableGroups } from './use-resource-pty-endable-groups'

export type ResourcePtyListItem =
  | { kind: 'group'; key: string; group: ResourcePtyGroup; open: boolean }
  | { kind: 'session'; key: string; row: PtyRow; showWorkspace: boolean }

const itemKey = (item: ResourcePtyListItem): string => item.key

export function ResourcePtyList({
  items,
  scrollElement,
  observedAt,
  unverifiable,
  status,
  endableGroups,
  checkingGroup,
  labelForRow,
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
  status: ResourcePtyActionStatus
  endableGroups: ReturnType<typeof useResourcePtyEndableGroups>
  checkingGroup: string | null
  labelForRow: (row: PtyRow) => string
  selected: ReadonlySet<string>
  openDetails: ReadonlySet<string>
  onToggleGroup: (key: string) => void
  onEndAll: (group: ResourcePtyGroup, source: Element) => void
  onActivate: (row: PtyRow, event: React.MouseEvent, canSelect: boolean) => void
  onEnd: (row: PtyRow) => void
  onNavigate: (tabId: string, paneKey: string | null) => void
}) {
  return (
    <ResourcePtyLabelContext value={labelForRow}>
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
              allowEndAll={
                !unverifiable && (checkingGroup === null || item.group.kind === 'unbound')
              }
              endableGroups={endableGroups}
              checking={checkingGroup === item.key}
              onToggle={onToggleGroup}
              onEndAll={onEndAll}
            />
          ) : (
            <ResourcePtyRow
              key={item.key}
              row={item.row}
              title={labelForRow(item.row)}
              showWorkspace={item.showWorkspace}
              observedAt={observedAt}
              unverifiable={unverifiable}
              status={status}
              selected={selected.has(item.row.identity)}
              detailsOpen={openDetails.has(item.row.identity)}
              onActivate={onActivate}
              onEnd={onEnd}
              onNavigate={onNavigate}
            />
          )
        }
      />
    </ResourcePtyLabelContext>
  )
}

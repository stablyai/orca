import React from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { getWorktreeHostIdentity } from '../../../../../shared/worktree/host-qualified-identity'
import { VirtualizedList } from '@/components/virtualized-list'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { isActiveSidebarWorkspace } from '../../../../../shared/sidebar-list/active-workspace'
import { useModifierHeldClass } from '@/components/editor/rich-markdown/viewport/useModifierHeldClass'
import { DIGIT_INDEX_ACTION_ID } from '@/components/worktree-jump/worktree-jump-palette-model'
import { getSidebarHeaderVisual } from '../worktree-list/rows/header-visuals'
import { resolveRepoHeaderColor } from '../worktree-list/rows/project-header-color'
import type { SidebarRailRow } from './sidebar-rail-rows'
import { SidebarRailWorktreeTile } from './SidebarRailWorktreeTile'
import { useRailPendingReveal } from './use-rail-pending-reveal'
import {
  SIDEBAR_RAIL_HEADER_SIZE,
  SIDEBAR_RAIL_HOST_HEADER_SIZE,
  SIDEBAR_RAIL_MOD_HELD_CLASS,
  SIDEBAR_RAIL_TILE_SIZE
} from './sidebar-rail-geometry'

const IS_MAC = getShortcutPlatform() === 'darwin'
const PLATFORM_MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl'

type SidebarRailWorktreeListProps = {
  rows: readonly SidebarRailRow[]
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
  selectedWorktreeIds: ReadonlySet<string>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  toggleGroup: (groupKey: string) => void
  forcedRevealWorktreeId: string | null
  onForceReveal: (worktreeId: string | null) => void
  onSelectionGesture: (event: React.MouseEvent<HTMLElement>, worktree: Worktree) => boolean
  onContextMenuSelect: (
    event: React.MouseEvent<HTMLElement>,
    worktree: Worktree
  ) => readonly Worktree[]
  onImmediateActivate: (worktreeId: string, rowKey: string | undefined) => void
  onWorktreeCardClick?: () => void
}

function getRowSize(row: SidebarRailRow): number {
  if (row.kind === 'tile') {
    return SIDEBAR_RAIL_TILE_SIZE
  }
  const separator = row.separated ? 9 : 0
  return (
    (row.kind === 'host' ? SIDEBAR_RAIL_HOST_HEADER_SIZE : SIDEBAR_RAIL_HEADER_SIZE) + separator
  )
}

function RailSeparator(): React.JSX.Element {
  return <div aria-hidden className="mx-auto my-1 h-px w-6 shrink-0 bg-worktree-sidebar-border" />
}

function RailHeader({
  row,
  workspaceStatuses,
  onToggle
}: {
  row: Extract<SidebarRailRow, { kind: 'header' }>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  onToggle: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const visual = getSidebarHeaderVisual(row.icon, workspaceStatuses, t)
  const label = row.label ?? visual.label ?? ''
  const Icon = visual.icon
  const showText = row.icon.kind === 'project' && label.length > 0
  const tooltip = row.collapsed
    ? t('auto.components.sidebar.rail.expandGroup', 'Expand {{label}} ({{count}})', {
        label,
        count: row.count
      })
    : t('auto.components.sidebar.rail.collapseGroup', 'Collapse {{label}}', { label })
  return (
    <div className="flex flex-col">
      {row.separated ? <RailSeparator /> : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!row.collapsed}
            aria-label={tooltip}
            className="mx-auto flex h-5.5 max-w-12 items-center justify-center gap-0.5 rounded-sm px-1 text-3xs font-semibold tracking-wider text-muted-foreground uppercase transition-colors hover:bg-worktree-sidebar-foreground/8 hover:text-worktree-sidebar-foreground"
          >
            {row.collapsed ? <ChevronRight className="size-2.5 shrink-0" /> : null}
            {showText ? (
              <span
                className="truncate"
                style={
                  row.repo ? { color: resolveRepoHeaderColor(row.repo.badgeColor) } : undefined
                }
              >
                {label}
              </span>
            ) : (
              <Icon className={cn('size-3 shrink-0', visual.tone)} />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

export function SidebarRailWorktreeList({
  rows,
  activeWorktreeId,
  activeWorkspaceExecutionHostId,
  selectedWorktreeIds,
  workspaceStatuses,
  toggleGroup,
  forcedRevealWorktreeId,
  onForceReveal,
  onSelectionGesture,
  onContextMenuSelect,
  onImmediateActivate,
  onWorktreeCardClick
}: SidebarRailWorktreeListProps): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const [scrollElement, setScrollElement] = React.useState<HTMLDivElement | null>(null)
  const attachScrollElement = React.useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element
    setScrollElement(element)
  }, [])
  useModifierHeldClass(scrollRef, IS_MAC, SIDEBAR_RAIL_MOD_HELD_CLASS)
  const digitModifiers =
    useShortcutKeyComboDetails(DIGIT_INDEX_ACTION_ID)[0]?.keys.slice(0, -1) ?? []
  const showShortcutHints = digitModifiers.length === 1 && digitModifiers[0] === PLATFORM_MOD_LABEL
  const activeRow = rows.find(
    (row) =>
      row.kind === 'tile' &&
      isActiveSidebarWorkspace(row.worktree, {
        worktreeId: activeWorktreeId,
        hostId: activeWorkspaceExecutionHostId
      })
  )

  const scrollTargetKey = useRailPendingReveal({
    rows,
    scrollRef,
    activeRowKey: activeRow?.key,
    forcedRevealWorktreeId,
    onForceReveal,
    toggleGroup
  })

  const renderRow = (row: SidebarRailRow): React.ReactNode => (
    <div style={{ height: getRowSize(row) }} data-rail-row-key={row.key}>
      {row.kind === 'host' ? (
        <div className="flex flex-col">
          {row.separated ? <RailSeparator /> : null}
          <div className="mx-auto max-w-12 truncate text-3xs text-muted-foreground">
            {row.label}
          </div>
        </div>
      ) : row.kind === 'header' ? (
        <RailHeader
          row={row}
          workspaceStatuses={workspaceStatuses}
          onToggle={() => toggleGroup(row.collapseKey)}
        />
      ) : (
        <div className="flex h-full items-center justify-center">
          <SidebarRailWorktreeTile
            worktree={row.worktree}
            repo={row.repo}
            rowKey={row.rowKey}
            isActive={row === activeRow}
            isMultiSelected={selectedWorktreeIds.has(getWorktreeHostIdentity(row.worktree))}
            shortcutNumber={row.shortcutNumber}
            showShortcutHint={showShortcutHints}
            inPinnedSection={row.inPinnedSection}
            hostContextLabel={row.hostContextLabel}
            showProjectName={row.showProjectName}
            onSelectionGesture={onSelectionGesture}
            onContextMenuSelect={onContextMenuSelect}
            onImmediateActivate={onImmediateActivate}
            onWorktreeCardClick={onWorktreeCardClick}
          />
        </div>
      )}
    </div>
  )

  return (
    <div
      ref={attachScrollElement}
      data-worktree-sidebar-container=""
      className="worktree-sidebar-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-1"
      data-sidebar-rail-list=""
    >
      <VirtualizedList
        rows={rows}
        getRowKey={(row) => row.key}
        renderRow={renderRow}
        scrollElement={scrollElement}
        estimateRowHeightPx={SIDEBAR_RAIL_TILE_SIZE}
        activeRowKey={scrollTargetKey}
        minimumRows={1}
      />
    </div>
  )
}

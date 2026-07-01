import React from 'react'
import {
  KeyRound,
  Loader2,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Plug,
  Trash2,
  Unplug,
  type LucideIcon
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { DbConnectionStatus, DbConnectionSummary } from '../../../../shared/database-types'
import {
  ConnectionStatusDot,
  isNoteworthyStatus,
  statusLabel,
  statusTextClass
} from './connection-status-indicator'

function engineLabel(engine: DbConnectionSummary['engine']): string {
  return engine === 'postgres'
    ? translate('auto.components.database.ConnectionList.postgres', 'Postgres')
    : translate('auto.components.database.ConnectionList.mysql', 'MySQL')
}

// A row action rendered identically into the overflow (⋯) menu and the
// right-click context menu, so both menus stay in sync from one source.
type RowAction =
  | { kind: 'separator'; key: string }
  | {
      kind: 'item'
      key: string
      label: string
      icon: LucideIcon
      onSelect: () => void
      destructive?: boolean
      disabled?: boolean
      spin?: boolean
    }

export interface ConnectionRowProps {
  connection: DbConnectionSummary
  status: DbConnectionStatus
  isActive: boolean
  onOpen: (id: string) => void
  onConnect: (id: string) => void
  onDisconnect: (id: string) => void
  onEdit: (connection: DbConnectionSummary) => void
  onDelete: (id: string) => void
}

export function ConnectionRow({
  connection,
  status,
  isActive,
  onOpen,
  onConnect,
  onDisconnect,
  onEdit,
  onDelete
}: ConnectionRowProps): React.JSX.Element {
  const isConnected = status === 'connected'
  const isBusy = status === 'connecting' || status === 'testing'

  // Double-click / Enter runs the primary intent: open the workspace when live,
  // otherwise (dis)connect. Connecting auto-selects the connection in the store.
  function runPrimary(): void {
    if (isBusy) { return }
    if (isConnected) { onOpen(connection.id) } else { onConnect(connection.id) }
  }

  const actions: RowAction[] = []
  if (isBusy) {
    actions.push({
      kind: 'item',
      key: 'busy',
      label: statusLabel(status),
      icon: Loader2,
      spin: true,
      disabled: true,
      onSelect: () => {}
    })
  } else if (isConnected) {
    actions.push(
      {
        kind: 'item',
        key: 'open',
        label: translate('auto.components.database.ConnectionList.open', 'Open'),
        icon: PanelRight,
        onSelect: () => onOpen(connection.id)
      },
      {
        kind: 'item',
        key: 'disconnect',
        label: translate('auto.components.database.ConnectionList.disconnect', 'Disconnect'),
        icon: Unplug,
        onSelect: () => onDisconnect(connection.id)
      }
    )
  } else {
    actions.push({
      kind: 'item',
      key: 'connect',
      label:
        status === 'lost'
          ? translate('auto.components.database.ConnectionList.reconnect', 'Reconnect')
          : translate('auto.components.database.ConnectionList.connect', 'Connect'),
      icon: Plug,
      onSelect: () => onConnect(connection.id)
    })
  }
  actions.push(
    { kind: 'separator', key: 'sep' },
    {
      kind: 'item',
      key: 'edit',
      label: translate('auto.components.database.ConnectionList.editAction', 'Edit'),
      icon: Pencil,
      onSelect: () => onEdit(connection)
    },
    {
      kind: 'item',
      key: 'delete',
      label: translate('auto.components.database.ConnectionList.deleteAction', 'Delete'),
      icon: Trash2,
      destructive: true,
      onSelect: () => onDelete(connection.id)
    }
  )

  const renderItems = (
    Item: typeof DropdownMenuItem | typeof ContextMenuItem,
    Separator: typeof DropdownMenuSeparator | typeof ContextMenuSeparator
  ): React.JSX.Element[] =>
    actions.map((action) =>
      action.kind === 'separator' ? (
        <Separator key={action.key} />
      ) : (
        <Item
          key={action.key}
          variant={action.destructive ? 'destructive' : 'default'}
          disabled={action.disabled}
          onSelect={action.onSelect}
        >
          <action.icon className={action.spin ? 'animate-spin' : undefined} />
          {action.label}
        </Item>
      )
    )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-current={isActive ? 'true' : undefined}
          onDoubleClick={runPrimary}
          className={cn(
            'flex select-none items-center gap-2 rounded-md px-2 py-2.5 transition-colors',
            isActive ? 'bg-accent' : 'hover:bg-accent'
          )}
        >
          <div
            role="button"
            tabIndex={0}
            aria-current={isActive ? 'true' : undefined}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                runPrimary()
              }
            }}
            className="min-w-0 flex-1 cursor-pointer space-y-1 text-left outline-none"
          >
            <div className="flex min-w-0 items-center gap-2">
              <ConnectionStatusDot status={status} />
              <span className="truncate text-sm font-medium">{connection.name}</span>
              <Badge variant="secondary" className="h-5 shrink-0 text-[10px]">
                {engineLabel(connection.engine)}
              </Badge>
              {connection.readOnly ? (
                <Badge variant="outline" className="h-5 shrink-0 text-[10px]">
                  {translate('auto.components.database.ConnectionList.readOnly', 'Read-only')}
                </Badge>
              ) : null}
              {isNoteworthyStatus(status) ? (
                <span
                  className={cn('shrink-0 text-[11px] font-medium', statusTextClass(status))}
                >
                  {statusLabel(status)}
                </span>
              ) : null}
            </div>
            <div className="flex min-w-0 items-center gap-1.5 pl-3.5">
              {connection.hasPassword ? (
                <KeyRound
                  className="size-3 shrink-0 text-muted-foreground"
                  aria-label={translate(
                    'auto.components.database.ConnectionList.passwordStored',
                    'Password stored'
                  )}
                />
              ) : null}
              <span className="truncate font-mono text-xs text-muted-foreground">
                {connection.user}@{connection.host}:{connection.port}/{connection.database}
              </span>
            </div>
          </div>

          <div className="shrink-0" onDoubleClick={(e) => e.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={translate(
                    'auto.components.database.ConnectionList.moreActions',
                    'More actions'
                  )}
                >
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {renderItems(DropdownMenuItem, DropdownMenuSeparator)}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>{renderItems(ContextMenuItem, ContextMenuSeparator)}</ContextMenuContent>
    </ContextMenu>
  )
}

import React, { useState } from 'react'
import { Database, KeyRound, Pencil, Plug, PlugZap, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConnectionStatusIndicator } from './connection-status-indicator'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { DbConnectionSummary } from '../../../../shared/database-types'
import { ConnectionForm } from './ConnectionForm'

function engineLabel(engine: DbConnectionSummary['engine']): string {
  return engine === 'postgres'
    ? translate('auto.components.database.ConnectionList.postgres', 'Postgres')
    : translate('auto.components.database.ConnectionList.mysql', 'MySQL')
}

function EmptyConnectionState({ onAddClick }: { onAddClick: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <Database className="size-7 text-muted-foreground" />
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">
            {translate(
              'auto.components.database.ConnectionList.emptyTitle',
              'No connections yet'
            )}
          </h3>
          <p className="text-xs leading-5 text-muted-foreground">
            {translate(
              'auto.components.database.ConnectionList.emptyBody',
              'Add a Postgres or MySQL connection to get started.'
            )}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onAddClick} className="gap-1.5">
          <Plus className="size-3.5" />
          {translate('auto.components.database.ConnectionList.addConnection', 'Add connection')}
        </Button>
      </div>
    </div>
  )
}

export function ConnectionList(): React.JSX.Element {
  const dbConnections = useAppStore((s) => s.dbConnections)
  const removeDbConnection = useAppStore((s) => s.removeDbConnection)
  const dbStatuses = useAppStore((s) => s.dbStatuses)
  const connectDbConnection = useAppStore((s) => s.connectDbConnection)
  const disconnectDbConnection = useAppStore((s) => s.disconnectDbConnection)
  const activeDbConnectionId = useAppStore((s) => s.activeDbConnectionId)
  const setActiveDbConnection = useAppStore((s) => s.setActiveDbConnection)

  const [formOpen, setFormOpen] = useState(false)
  const [editingConnection, setEditingConnection] = useState<DbConnectionSummary | undefined>(
    undefined
  )
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const deletingConnection = dbConnections.find((c) => c.id === deletingId) ?? null

  async function handleConnect(id: string): Promise<void> {
    const result = await connectDbConnection(id)
    if (result.status === 'error' || result.status === 'lost') {
      toast.error(
        result.error?.safeMessage ??
          translate(
            'auto.components.database.ConnectionList.errorConnect',
            'Failed to connect'
          )
      )
    }
  }

  async function handleDisconnect(id: string): Promise<void> {
    try {
      await disconnectDbConnection(id)
    } catch {
      toast.error(
        translate(
          'auto.components.database.ConnectionList.errorDisconnect',
          'Failed to disconnect'
        )
      )
    }
  }

  function openCreate(): void {
    setEditingConnection(undefined)
    setFormOpen(true)
  }

  function openEdit(connection: DbConnectionSummary): void {
    setEditingConnection(connection)
    setFormOpen(true)
  }

  async function handleDelete(): Promise<void> {
    if (!deletingId) { return }
    const id = deletingId
    setDeletingId(null)
    try {
      await removeDbConnection(id)
    } catch (error) {
      console.error('Failed to remove connection:', error)
      toast.error(
        translate(
          'auto.components.database.ConnectionList.errorDelete',
          'Failed to remove connection'
        )
      )
    }
  }

  return (
    <>
      {dbConnections.length === 0 ? (
        <EmptyConnectionState onAddClick={openCreate} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-end border-b border-border px-5 py-3">
            <Button variant="outline" size="sm" onClick={openCreate} className="gap-1.5">
              <Plus className="size-3.5" />
              {translate(
                'auto.components.database.ConnectionList.addConnection',
                'Add connection'
              )}
            </Button>
          </div>
          <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
            <div className="divide-y divide-border px-5">
              {dbConnections.map((connection) => {
                const status = dbStatuses[connection.id]?.status ?? 'idle'
                const isConnected = status === 'connected'
                const isBusy = status === 'connecting' || status === 'testing'
                const isActive = activeDbConnectionId === connection.id
                return (
                  <div key={connection.id} className="flex items-center gap-3 py-3">
                    <div
                      role="button"
                      tabIndex={isConnected ? 0 : -1}
                      aria-disabled={!isConnected}
                      onClick={() => {
                        if (isConnected) { setActiveDbConnection(connection.id) }
                      }}
                      onKeyDown={(e) => {
                        if (isConnected && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault()
                          setActiveDbConnection(connection.id)
                        }
                      }}
                      className={`min-w-0 flex-1 space-y-1 rounded-md px-2 py-1 text-left ${
                        isConnected ? 'cursor-pointer hover:bg-accent/50' : 'cursor-default'
                      } ${isActive ? 'bg-accent/60' : ''}`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{connection.name}</span>
                        <Badge variant="secondary" className="h-5 text-[10px]">
                          {engineLabel(connection.engine)}
                        </Badge>
                        {connection.readOnly ? (
                          <Badge variant="outline" className="h-5 text-[10px]">
                            {translate(
                              'auto.components.database.ConnectionList.readOnly',
                              'Read-only'
                            )}
                          </Badge>
                        ) : null}
                        <ConnectionStatusIndicator status={status} />
                        {connection.hasPassword ? (
                          <KeyRound
                            className="size-3 text-muted-foreground"
                            aria-label={translate(
                              'auto.components.database.ConnectionList.passwordStored',
                              'Password stored'
                            )}
                          />
                        ) : null}
                      </div>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {connection.user}@{connection.host}:{connection.port}/{connection.database}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {isConnected ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          onClick={() => void handleDisconnect(connection.id)}
                        >
                          <PlugZap className="size-3.5" />
                          {translate(
                            'auto.components.database.ConnectionList.disconnect',
                            'Disconnect'
                          )}
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          disabled={isBusy}
                          onClick={() => void handleConnect(connection.id)}
                        >
                          <Plug className="size-3.5" />
                          {status === 'lost'
                            ? translate(
                                'auto.components.database.ConnectionList.reconnect',
                                'Reconnect'
                              )
                            : translate(
                                'auto.components.database.ConnectionList.connect',
                                'Connect'
                              )}
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => openEdit(connection)}
                      >
                        <Pencil className="size-3.5" />
                        <span className="sr-only">
                          {translate(
                            'auto.components.database.ConnectionList.editAction',
                            'Edit'
                          )}
                        </span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => setDeletingId(connection.id)}
                      >
                        <Trash2 className="size-3.5" />
                        <span className="sr-only">
                          {translate(
                            'auto.components.database.ConnectionList.deleteAction',
                            'Delete'
                          )}
                        </span>
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      <Dialog
        open={deletingId !== null}
        onOpenChange={(open) => {
          if (!open) { setDeletingId(null) }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {translate(
                'auto.components.database.ConnectionList.confirmDeleteTitle',
                'Delete connection'
              )}
            </DialogTitle>
            {deletingConnection ? (
              <DialogDescription>
                {translate(
                  'auto.components.database.ConnectionList.confirmDeleteBody',
                  'Permanently remove "{{name}}"? This cannot be undone.',
                  { name: deletingConnection.name }
                )}
              </DialogDescription>
            ) : null}
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingId(null)}>
              {translate('auto.components.database.ConnectionList.cancelDelete', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                void handleDelete()
              }}
            >
              {translate(
                'auto.components.database.ConnectionList.confirmDeleteAction',
                'Delete'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConnectionForm
        open={formOpen}
        onOpenChange={setFormOpen}
        connection={editingConnection}
      />
    </>
  )
}

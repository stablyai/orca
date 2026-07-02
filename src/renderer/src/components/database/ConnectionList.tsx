import React, { useState } from 'react'
import { Database, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
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
import { ConnectionRow } from './connection-row'

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
            <div className="divide-y divide-border px-3 py-1">
              {dbConnections.map((connection) => (
                <ConnectionRow
                  key={connection.id}
                  connection={connection}
                  status={dbStatuses[connection.id]?.status ?? 'idle'}
                  isActive={activeDbConnectionId === connection.id}
                  onOpen={setActiveDbConnection}
                  onConnect={(id) => void handleConnect(id)}
                  onDisconnect={(id) => void handleDisconnect(id)}
                  onEdit={openEdit}
                  onDelete={setDeletingId}
                />
              ))}
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

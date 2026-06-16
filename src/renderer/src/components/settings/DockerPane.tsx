import React, { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import type { DockerConnection } from '../../../../shared/docker-types'
import type { SshTarget } from '../../../../shared/ssh-types'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  buildDockerConnectionFromDraft,
  type DockerConnectionDraft
} from '../docker/docker-connection-draft'
import { DockerConfirmDialog } from '../docker/DockerConfirmDialog'

const EMPTY_DRAFT: DockerConnectionDraft = {
  label: '',
  kind: 'ssh',
  sshTargetId: '',
  tcpHost: '',
  tcpPort: ''
}

function draftFromConnection(connection: DockerConnection): DockerConnectionDraft {
  if (connection.kind === 'ssh') {
    return { label: connection.label, kind: 'ssh', sshTargetId: connection.sshTargetId ?? '', tcpHost: '', tcpPort: '' }
  }
  // tcp
  return {
    label: connection.label,
    kind: 'tcp',
    sshTargetId: '',
    tcpHost: connection.tcp?.host ?? '',
    tcpPort: connection.tcp?.port != null ? String(connection.tcp.port) : ''
  }
}

function connectionSummary(connection: DockerConnection, sshTargets: SshTarget[]): string {
  if (connection.kind === 'ssh') {
    const target = sshTargets.find((t) => t.id === connection.sshTargetId)
    if (target) {
      return target.label || `${target.username}@${target.host}:${target.port}`
    }
    return connection.sshTargetId ?? 'ssh'
  }
  if (connection.kind === 'tcp' && connection.tcp) {
    return `tcp://${connection.tcp.host}:${connection.tcp.port}`
  }
  return connection.kind
}

export function DockerPane(): React.JSX.Element {
  const userConnections = useAppStore((s) => s.settings?.dockerConnections) ?? []
  const updateSettings = useAppStore((s) => s.updateSettings)

  const [sshTargets, setSshTargets] = useState<SshTarget[]>([])
  useEffect(() => {
    void window.api.ssh.listTargets().then(setSshTargets)
  }, [])

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<DockerConnectionDraft>(EMPTY_DRAFT)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Remove confirm dialog state
  const [removeTarget, setRemoveTarget] = useState<DockerConnection | null>(null)

  const openAdd = (): void => {
    setEditingId(null)
    setDraft(EMPTY_DRAFT)
    setFormError(null)
    setShowForm(true)
  }

  const openEdit = (connection: DockerConnection): void => {
    setEditingId(connection.id)
    setDraft(draftFromConnection(connection))
    setFormError(null)
    setShowForm(true)
  }

  const cancelForm = (): void => {
    setShowForm(false)
    setEditingId(null)
    setDraft(EMPTY_DRAFT)
    setFormError(null)
  }

  const handleSave = async (): Promise<void> => {
    const result = buildDockerConnectionFromDraft(draft, editingId ?? crypto.randomUUID())
    if (!result.ok) {
      setFormError(result.error)
      return
    }
    setSaving(true)
    try {
      const next = editingId
        ? userConnections.map((c) => (c.id === editingId ? result.connection : c))
        : [...userConnections, result.connection]
      await updateSettings({ dockerConnections: next })
      cancelForm()
    } finally {
      setSaving(false)
    }
  }

  const handleRemoveConfirm = async (): Promise<void> => {
    if (!removeTarget) return
    const id = removeTarget.id
    await updateSettings({ dockerConnections: userConnections.filter((c) => c.id !== id) })
  }

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">
            {translate('auto.components.settings.DockerPane.5376fcfd12', 'Docker connections')}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.DockerPane.06c5aa419f',
              'Add connections to remote Docker daemons via SSH or TCP. The built-in Local connection is always available and cannot be removed.'
            )}
          </p>
        </div>
        {!showForm ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button variant="outline" size="xs" onClick={openAdd} className="gap-1.5">
              <Plus className="size-3" />
              {translate('auto.components.settings.DockerPane.9057b5e881', 'Add connection')}
            </Button>
          </div>
        ) : null}
      </div>

      {/* Connection list */}
      {userConnections.length === 0 && !showForm ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-5 text-sm text-muted-foreground">
          {translate('auto.components.settings.DockerPane.62a42ba95e', 'No connections configured.')}
        </div>
      ) : (
        <div className="space-y-2">
          {userConnections.map((connection) => (
            <div
              key={connection.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/30 px-3 py-2.5"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="truncate text-sm font-medium">{connection.label}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {connection.kind} · {connectionSummary(connection, sshTargets)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button variant="ghost" size="xs" onClick={() => openEdit(connection)}>
                  {translate('auto.components.settings.DockerPane.137bb072b2', 'Edit')}
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setRemoveTarget(connection)}
                >
                  {translate('auto.components.settings.DockerPane.18953f5560', 'Remove')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add/Edit form */}
      {showForm ? (
        <div className="space-y-3 rounded-lg border border-border/60 bg-card/30 px-3 py-3">
          <p className="text-xs font-medium text-muted-foreground">
            {editingId
              ? translate('auto.components.settings.DockerPane.5df5b4a07f', 'Editing connection')
              : translate('auto.components.settings.DockerPane.9057b5e881', 'Add connection')}
          </p>

          {/* Label */}
          <div className="space-y-1.5">
            <Label className="text-xs">
              {translate('auto.components.settings.DockerPane.c6b030f1bd', 'Label')}
            </Label>
            <Input
              value={draft.label}
              onChange={(e) => {
                setFormError(null)
                setDraft((d) => ({ ...d, label: e.target.value }))
              }}
              className="h-7 text-xs"
            />
          </div>

          {/* Kind */}
          <div className="space-y-1.5">
            <Label className="text-xs">
              {translate('auto.components.settings.DockerPane.828891863d', 'Kind')}
            </Label>
            <Select
              value={draft.kind}
              onValueChange={(v) => {
                setFormError(null)
                setDraft((d) => ({ ...d, kind: v as 'ssh' | 'tcp' }))
              }}
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ssh">
                  {translate('auto.components.settings.DockerPane.629de6fba3', 'ssh')}
                </SelectItem>
                <SelectItem value="tcp">
                  {translate('auto.components.settings.DockerPane.25b3c0539d', 'tcp')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* SSH host picker */}
          {draft.kind === 'ssh' ? (
            <div className="space-y-1.5">
              <Label className="text-xs">
                {translate('auto.components.settings.DockerPane.2b71443426', 'SSH host')}
              </Label>
              {sshTargets.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.settings.DockerPane.b31014c60f',
                    'No SSH targets configured. Add one in Remote Hosts first.'
                  )}
                </p>
              ) : (
                <Select
                  value={draft.sshTargetId}
                  onValueChange={(v) => {
                    setFormError(null)
                    setDraft((d) => ({ ...d, sshTargetId: v }))
                  }}
                >
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {sshTargets.map((target) => (
                      <SelectItem key={target.id} value={target.id}>
                        {target.label || `${target.username}@${target.host}:${target.port}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          ) : null}

          {/* TCP fields */}
          {draft.kind === 'tcp' ? (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">
                  {translate('auto.components.settings.DockerPane.cea67e3330', 'Host')}
                </Label>
                <Input
                  value={draft.tcpHost}
                  onChange={(e) => {
                    setFormError(null)
                    setDraft((d) => ({ ...d, tcpHost: e.target.value }))
                  }}
                  className="h-7 text-xs"
                  placeholder="localhost"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">
                  {translate('auto.components.settings.DockerPane.0b65603482', 'Port')}
                </Label>
                <Input
                  value={draft.tcpPort}
                  onChange={(e) => {
                    setFormError(null)
                    setDraft((d) => ({ ...d, tcpPort: e.target.value }))
                  }}
                  className="h-7 text-xs"
                  placeholder="2375"
                />
              </div>
            </>
          ) : null}

          {/* Inline error */}
          {formError ? (
            <p className={cn('text-xs', 'text-destructive')}>{formError}</p>
          ) : null}

          {/* Form actions */}
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              {translate('auto.components.settings.DockerPane.64ae773bd2', 'Save')}
            </Button>
            <Button variant="ghost" size="xs" onClick={cancelForm}>
              {translate('auto.components.settings.DockerPane.ab331bd060', 'Cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Remove confirm dialog */}
      <DockerConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null)
        }}
        title={translate(
          'auto.components.settings.DockerPane.7b01b87358',
          'Remove Docker connection'
        )}
        description={`${translate('auto.components.settings.DockerPane.e26705cecb', 'This will remove the connection')} "${removeTarget?.label ?? ''}".`}
        confirmLabel={translate(
          'auto.components.settings.DockerPane.78a9fd8cf7',
          'Remove connection'
        )}
        onConfirm={handleRemoveConfirm}
      />
    </div>
  )
}

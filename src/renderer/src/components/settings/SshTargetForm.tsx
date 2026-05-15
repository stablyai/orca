import { FileKey } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

export type EditingTarget = {
  label: string
  configHost: string
  host: string
  port: string
  username: string
  identityFile: string
  proxyCommand: string
  jumpHost: string
  relayGracePeriodSeconds: string
  remoteWorkspaceSyncEnabled: boolean
  remoteWorkspaceSyncGracePeriodSeconds: string
}

export const EMPTY_FORM: EditingTarget = {
  label: '',
  configHost: '',
  host: '',
  port: '22',
  username: '',
  identityFile: '',
  proxyCommand: '',
  jumpHost: '',
  relayGracePeriodSeconds: '300',
  remoteWorkspaceSyncEnabled: false,
  remoteWorkspaceSyncGracePeriodSeconds: '300'
}

type SshTargetFormProps = {
  editingId: string | null
  form: EditingTarget
  onFormChange: (updater: (prev: EditingTarget) => EditingTarget) => void
  onSave: () => void
  onCancel: () => void
}

export function SshTargetForm({
  editingId,
  form,
  onFormChange,
  onSave,
  onCancel
}: SshTargetFormProps): React.JSX.Element {
  return (
    <form
      className="space-y-4 rounded-lg border border-border/50 bg-card/40 p-4"
      onSubmit={(e) => {
        e.preventDefault()
        onSave()
      }}
    >
      <p className="text-sm font-medium">{editingId ? 'Edit SSH Target' : 'New SSH Target'}</p>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label>Label</Label>
          <Input
            value={form.label}
            onChange={(e) => onFormChange((f) => ({ ...f, label: e.target.value }))}
            placeholder="My Server"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Host *</Label>
          <Input
            value={form.host}
            onChange={(e) => onFormChange((f) => ({ ...f, host: e.target.value }))}
            placeholder="192.168.1.100 or server.example.com"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Username *</Label>
          <Input
            value={form.username}
            onChange={(e) => onFormChange((f) => ({ ...f, username: e.target.value }))}
            placeholder="deploy"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Port</Label>
          <Input
            type="number"
            value={form.port}
            onChange={(e) => onFormChange((f) => ({ ...f, port: e.target.value }))}
            placeholder="22"
            min={1}
            max={65535}
          />
        </div>
        <div className="col-span-2 space-y-1.5">
          <Label className="flex items-center gap-1.5">
            <FileKey className="size-3.5" />
            Identity File
          </Label>
          <Input
            value={form.identityFile}
            onChange={(e) => onFormChange((f) => ({ ...f, identityFile: e.target.value }))}
            placeholder="~/.ssh/id_ed25519 (leave empty for SSH agent)"
          />
          <p className="text-[11px] text-muted-foreground">
            Optional. SSH agent is used by default.
          </p>
        </div>
        <div className="col-span-2 space-y-1.5">
          <Label>Proxy Command</Label>
          <Input
            value={form.proxyCommand}
            onChange={(e) => onFormChange((f) => ({ ...f, proxyCommand: e.target.value }))}
            placeholder="e.g. cloudflared access ssh --hostname %h"
          />
          <p className="text-[11px] text-muted-foreground">
            Optional. Used for tunneling (e.g. Cloudflare Access, ProxyCommand).
          </p>
        </div>
        <div className="col-span-2 space-y-1.5">
          <Label>Jump Host</Label>
          <Input
            value={form.jumpHost}
            onChange={(e) => onFormChange((f) => ({ ...f, jumpHost: e.target.value }))}
            placeholder="bastion.example.com"
          />
          <p className="text-[11px] text-muted-foreground">
            Optional. Equivalent to ProxyJump / ssh -J.
          </p>
        </div>
        <div className="col-span-2 space-y-1.5">
          <Label>Relay Grace Period (seconds)</Label>
          <Input
            type="number"
            value={form.relayGracePeriodSeconds}
            onChange={(e) =>
              onFormChange((f) => ({ ...f, relayGracePeriodSeconds: e.target.value }))
            }
            placeholder="300"
            min={60}
            max={3600}
          />
          <p className="text-[11px] text-muted-foreground">
            How long the relay keeps terminals alive after disconnect. Default: 300 (5 minutes).
          </p>
        </div>
        <div className="col-span-2 space-y-3 border-t border-border/50 pt-3">
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-foreground"
              checked={form.remoteWorkspaceSyncEnabled}
              onChange={(e) =>
                onFormChange((f) => ({ ...f, remoteWorkspaceSyncEnabled: e.target.checked }))
              }
            />
            <span className="space-y-1">
              <span className="block font-medium">Sync remote workspace</span>
              <span className="block text-[11px] text-muted-foreground">
                Store terminal tabs and split layouts on the SSH host so another Orca client can
                restore the same remote workspace.
              </span>
            </span>
          </label>
          {form.remoteWorkspaceSyncEnabled && (
            <div className="space-y-1.5 pl-7">
              <Label>Synced Relay Grace Period (seconds)</Label>
              <Input
                type="number"
                value={form.remoteWorkspaceSyncGracePeriodSeconds}
                onChange={(e) =>
                  onFormChange((f) => ({
                    ...f,
                    remoteWorkspaceSyncGracePeriodSeconds: e.target.value
                  }))
                }
                placeholder="0"
                min={0}
                max={3600}
              />
              <p className="text-[11px] text-muted-foreground">
                How long synced remote workspace terminals stay alive after all clients disconnect.
                0 keeps them alive until explicitly terminated.
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm">
          {editingId ? 'Save Changes' : 'Add Target'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

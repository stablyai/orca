import { FileKey } from 'lucide-react'
import {
  DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MIN_SSH_RELAY_GRACE_PERIOD_SECONDS
} from '../../../../shared/ssh-types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { applyParsedSshHostInput, type EditingTarget } from './ssh-target-draft'
import { translate } from '@/i18n/i18n'
export { EMPTY_FORM, type EditingTarget } from './ssh-target-draft'

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
      <p className="text-sm font-medium">{editingId ? translate("auto.components.settings.SshTargetForm.f2331ce599", "Edit SSH Target") : translate("auto.components.settings.SshTargetForm.29af933cd5", "New SSH Target")}</p>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label>{translate("auto.components.settings.SshTargetForm.298de87a88", "Label")}</Label>
          <Input
            value={form.label}
            onChange={(e) => onFormChange((f) => ({ ...f, label: e.target.value }))}
            placeholder={translate("auto.components.settings.SshTargetForm.b8dab0aa7b", "My Server")}
          />
        </div>
        <div className="space-y-1.5">
          <Label>{translate("auto.components.settings.SshTargetForm.ce370ce674", "Host or alias *")}</Label>
          <Input
            value={form.host}
            onChange={(e) => onFormChange((f) => ({ ...f, host: e.target.value }))}
            onBlur={() => onFormChange(applyParsedSshHostInput)}
            placeholder={translate("auto.components.settings.SshTargetForm.2ee9bcd2e8", "server, deploy@server:2222, ssh://server")}
          />
        </div>
        <div className="space-y-1.5">
          <Label>{translate("auto.components.settings.SshTargetForm.dc1dc52aaa", "Username")}</Label>
          <Input
            value={form.username}
            onChange={(e) => onFormChange((f) => ({ ...f, username: e.target.value }))}
            placeholder={translate("auto.components.settings.SshTargetForm.47e082bc17", "deploy")}
          />
        </div>
        <div className="space-y-1.5">
          <Label>{translate("auto.components.settings.SshTargetForm.c94cfa634c", "Port")}</Label>
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
            {translate("auto.components.settings.SshTargetForm.63c0c145c1", "Identity File")}</Label>
          <Input
            value={form.identityFile}
            onChange={(e) => onFormChange((f) => ({ ...f, identityFile: e.target.value }))}
            placeholder={translate("auto.components.settings.SshTargetForm.d6a5f2ee5c", "~/.ssh/id_ed25519 (leave empty for SSH agent)")}
          />
          <p className="text-[11px] text-muted-foreground">
            {translate("auto.components.settings.SshTargetForm.cb91f6375c", "Optional. SSH agent is used by default.")}</p>
        </div>
        <div className="col-span-2 space-y-1.5">
          <Label>{translate("auto.components.settings.SshTargetForm.c7d0e18ecb", "Proxy Command")}</Label>
          <Input
            value={form.proxyCommand}
            onChange={(e) => onFormChange((f) => ({ ...f, proxyCommand: e.target.value }))}
            placeholder={translate("auto.components.settings.SshTargetForm.f42d844544", "e.g. cloudflared access ssh --hostname %h")}
          />
          <p className="text-[11px] text-muted-foreground">
            {translate("auto.components.settings.SshTargetForm.3b01ca44a0", "Optional. Used for tunneling (e.g. Cloudflare Access, ProxyCommand).")}</p>
        </div>
        <div className="col-span-2 space-y-1.5">
          <Label>{translate("auto.components.settings.SshTargetForm.b2ab248ded", "Jump Host")}</Label>
          <Input
            value={form.jumpHost}
            onChange={(e) => onFormChange((f) => ({ ...f, jumpHost: e.target.value }))}
            placeholder={translate("auto.components.settings.SshTargetForm.11bcb4507a", "bastion.example.com")}
          />
          <p className="text-[11px] text-muted-foreground">
            {translate("auto.components.settings.SshTargetForm.feae1d1e69", "Optional. Equivalent to ProxyJump / ssh -J.")}</p>
        </div>
        <div className="col-span-2 space-y-1.5">
          <Label>{translate("auto.components.settings.SshTargetForm.92f80edbfd", "Relay Grace Period (seconds)")}</Label>
          <Input
            type={form.relayKeepAliveUntilReset ? 'text' : 'number'}
            value={form.relayKeepAliveUntilReset ? 'Until reset' : form.relayGracePeriodSeconds}
            onChange={(e) =>
              onFormChange((f) => ({ ...f, relayGracePeriodSeconds: e.target.value }))
            }
            placeholder={String(DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS)}
            min={MIN_SSH_RELAY_GRACE_PERIOD_SECONDS}
            max={MAX_SSH_RELAY_GRACE_PERIOD_SECONDS}
            disabled={form.relayKeepAliveUntilReset}
          />
          <label className="flex cursor-pointer items-start gap-2.5 py-1 text-xs">
            <input
              type="checkbox"
              className="mt-0.5 size-3.5 shrink-0 accent-foreground"
              checked={form.relayKeepAliveUntilReset}
              onChange={(e) =>
                onFormChange((f) => ({ ...f, relayKeepAliveUntilReset: e.target.checked }))
              }
            />
            <span className="space-y-0.5">
              <span className="block font-medium text-foreground">{translate("auto.components.settings.SshTargetForm.71fc546097", "Keep alive until reset")}</span>
              <span className="block text-muted-foreground">
                {translate("auto.components.settings.SshTargetForm.b574994adc", "Remote terminals stay available until you end them or reset the relay.")}</span>
            </span>
          </label>
          <p className="text-[11px] text-muted-foreground">
            {translate("auto.components.settings.SshTargetForm.137e88ce8d", "How long the relay keeps terminals alive after disconnect. Default: 10800 (3 hours). Maximum:")}{MAX_SSH_RELAY_GRACE_PERIOD_SECONDS} {translate("auto.components.settings.SshTargetForm.1b19b00e93", "(7 days).")}</p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm">
          {editingId ? translate("auto.components.settings.SshTargetForm.a62b4cb39a", "Save Changes") : translate("auto.components.settings.SshTargetForm.9518545cb6", "Add Target")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {translate("auto.components.settings.SshTargetForm.fea9cb402e", "Cancel")}</Button>
      </div>
    </form>
  )
}

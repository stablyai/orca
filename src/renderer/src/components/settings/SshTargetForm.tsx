import { useEffect, useRef, useState } from 'react'
import { FileKey } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SshHostAdvancedFields } from './SshHostAdvancedFields'
import {
  applyParsedSshHostInput,
  hasAdvancedConnectionValues,
  type EditingTarget
} from './ssh-target-draft'
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
  // Why: reveal Advanced by default when editing a target that already has custom proxy/jump/
  // reuse values, so those aren't hidden; otherwise it starts collapsed.
  const hasAdvancedConnectionFields = hasAdvancedConnectionValues(form)
  const [advancedOpen, setAdvancedOpen] = useState(hasAdvancedConnectionFields)
  const lastEditingIdRef = useRef(editingId)

  useEffect(() => {
    if (lastEditingIdRef.current === editingId) {
      return
    }
    lastEditingIdRef.current = editingId
    setAdvancedOpen(hasAdvancedConnectionFields)
  }, [editingId, hasAdvancedConnectionFields])

  return (
    <form
      className="space-y-4 rounded-lg border border-border/50 bg-card/40 p-4"
      onSubmit={(e) => {
        e.preventDefault()
        onSave()
      }}
    >
      <p className="text-sm font-medium">
        {editingId
          ? translate('auto.components.settings.SshTargetForm.f2331ce599', 'Edit SSH Target')
          : translate('auto.components.settings.SshTargetForm.29af933cd5', 'New SSH Target')}
      </p>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label>{translate('auto.components.settings.SshTargetForm.298de87a88', 'Label')}</Label>
          <Input
            value={form.label}
            onChange={(e) => onFormChange((f) => ({ ...f, label: e.target.value }))}
            placeholder={translate(
              'auto.components.settings.SshTargetForm.b8dab0aa7b',
              'My Server'
            )}
          />
        </div>
        <div className="space-y-1.5">
          <Label>
            {translate('auto.components.settings.SshTargetForm.ce370ce674', 'Host or alias *')}
          </Label>
          <Input
            value={form.host}
            onChange={(e) => onFormChange((f) => ({ ...f, host: e.target.value }))}
            onBlur={() => onFormChange(applyParsedSshHostInput)}
            placeholder={translate(
              'auto.components.settings.SshTargetForm.2ee9bcd2e8',
              'server, deploy@server:2222, ssh://server'
            )}
          />
        </div>
        <div className="space-y-1.5">
          <Label>
            {translate('auto.components.settings.SshTargetForm.dc1dc52aaa', 'Username')}
          </Label>
          <Input
            value={form.username}
            onChange={(e) => onFormChange((f) => ({ ...f, username: e.target.value }))}
            placeholder={translate('auto.components.settings.SshTargetForm.47e082bc17', 'deploy')}
          />
        </div>
        <div className="space-y-1.5">
          <Label>{translate('auto.components.settings.SshTargetForm.c94cfa634c', 'Port')}</Label>
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
            {translate('auto.components.settings.SshTargetForm.63c0c145c1', 'Identity File')}
          </Label>
          <Input
            value={form.identityFile}
            onChange={(e) => onFormChange((f) => ({ ...f, identityFile: e.target.value }))}
            placeholder={translate(
              'auto.components.settings.SshTargetForm.d6a5f2ee5c',
              '~/.ssh/id_ed25519 (leave empty for SSH agent)'
            )}
          />
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'auto.components.settings.SshTargetForm.cb91f6375c',
              'Optional. SSH agent is used by default.'
            )}
          </p>
        </div>
        <SshHostAdvancedFields
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
          form={form}
          disabled={false}
          onFormChange={onFormChange}
        />
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm">
          {editingId
            ? translate('auto.components.settings.SshTargetForm.a62b4cb39a', 'Save Changes')
            : translate('auto.components.settings.SshTargetForm.9518545cb6', 'Add Target')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {translate('auto.components.settings.SshTargetForm.fea9cb402e', 'Cancel')}
        </Button>
      </div>
    </form>
  )
}

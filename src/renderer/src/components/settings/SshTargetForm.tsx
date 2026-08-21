import { useEffect, useRef, useState } from 'react'
import { FileKey } from 'lucide-react'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SshHostAdvancedFields } from './SshHostAdvancedFields'
import {
  applyParsedSshHostInput,
  hasAdvancedConnectionValues,
  isSshTargetFormDirty,
  type EditingTarget
} from './ssh-target-draft'
import { translate } from '@/i18n/i18n'
export { EMPTY_FORM, type EditingTarget } from './ssh-target-draft'

type SshTargetFormProps = {
  open: boolean
  editingId: string | null
  form: EditingTarget
  saving: boolean
  onFormChange: (updater: (prev: EditingTarget) => EditingTarget) => void
  onSave: () => void
  onOpenChange: (open: boolean) => void
}

function editingEndpointSummary(form: EditingTarget): string {
  const host = form.host.trim()
  if (!host) {
    return form.label.trim()
  }
  const username = form.username.trim()
  const port = form.port.trim()
  const userHost = username ? `${username}@${host}` : host
  return port ? `${userHost}:${port}` : userHost
}

export function SshTargetForm({
  open,
  editingId,
  form,
  saving,
  onFormChange,
  onSave,
  onOpenChange
}: SshTargetFormProps): React.JSX.Element {
  // Why: reveal Advanced by default when the session starts with custom proxy/jump/
  // reuse values; otherwise start collapsed. Reset per open/edit session so state
  // does not leak across cancel → reopen (form component stays mounted).
  const hasAdvancedConnectionFields = hasAdvancedConnectionValues(form)
  const [advancedOpen, setAdvancedOpen] = useState(hasAdvancedConnectionFields)
  const baselineRef = useRef(form)
  // Why: the session effect and the outside-dismiss handler need the latest draft
  // without re-subscribing the effect to every keystroke. Sync in an effect so
  // render stays pure (React may replay/discard render work).
  const formRef = useRef(form)
  useEffect(() => {
    formRef.current = form
  })
  const sessionRef = useRef<{ open: boolean; editingId: string | null }>({
    open: false,
    editingId: null
  })

  useEffect(() => {
    if (!open) {
      sessionRef.current = { open: false, editingId: null }
      return
    }
    const sessionChanged = !sessionRef.current.open || sessionRef.current.editingId !== editingId
    if (!sessionChanged) {
      return
    }
    sessionRef.current = { open: true, editingId }
    baselineRef.current = formRef.current
    setAdvancedOpen(hasAdvancedConnectionValues(formRef.current))
  }, [open, editingId])

  const isEditing = editingId != null
  const editingLabel = form.label.trim()
  const endpointSummary = editingEndpointSummary(form)
  const showEditingChip =
    isEditing &&
    (editingLabel !== '' || (endpointSummary !== '' && endpointSummary !== editingLabel))

  const preventOutsideDismiss = (event: Event): void => {
    // Why: outside click is easy to hit by accident with a long multi-field form;
    // keep Escape / Cancel / × as explicit discard paths. Read both refs at call
    // time — the session effect can rewrite the baseline without a re-render.
    if (isSshTargetFormDirty(formRef.current, baselineRef.current)) {
      event.preventDefault()
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[calc(100vh-3rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
        onPointerDownOutside={preventOutsideDismiss}
        onInteractOutside={preventOutsideDismiss}
      >
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            // Why: Enter still submits while the button is disabled, so gate here too.
            if (saving) {
              return
            }
            onSave()
          }}
        >
          <DialogHeader className="shrink-0 gap-1.5 border-b border-border/60 px-6 pt-6 pr-12 pb-4 text-left">
            <DialogTitle>
              {isEditing
                ? translate('auto.components.settings.SshTargetForm.editTitle', 'Edit SSH host')
                : translate('auto.components.settings.SshTargetForm.addTitle', 'Add SSH host')}
            </DialogTitle>
            <DialogDescription>
              {isEditing
                ? translate(
                    'auto.components.settings.SshTargetForm.editDescription',
                    'Update connection details for this machine. Changes apply on next connect.'
                  )
                : translate(
                    'auto.components.settings.SshTargetForm.addDescription',
                    'Add a persistent machine you can log into over SSH.'
                  )}
            </DialogDescription>
            {showEditingChip ? (
              <p className="mt-0.5 inline-flex max-w-full items-center gap-1.5 truncate rounded-full border border-border/60 bg-muted/20 px-2.5 py-1 text-[11px] text-muted-foreground">
                {translate('auto.components.settings.SshTargetForm.editingPrefix', 'Editing')}
                {editingLabel !== '' ? (
                  <span className="font-medium text-foreground">{editingLabel}</span>
                ) : null}
                {editingLabel !== '' &&
                endpointSummary !== '' &&
                endpointSummary !== editingLabel ? (
                  <span aria-hidden="true">·</span>
                ) : null}
                {endpointSummary !== '' && endpointSummary !== editingLabel ? (
                  <span className="truncate font-mono text-[11px] text-foreground">
                    {endpointSummary}
                  </span>
                ) : null}
              </p>
            ) : null}
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 scrollbar-sleek">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ssh-target-label">
                  {translate('auto.components.settings.SshTargetForm.298de87a88', 'Label')}
                </Label>
                <Input
                  id="ssh-target-label"
                  value={form.label}
                  onChange={(e) => onFormChange((f) => ({ ...f, label: e.target.value }))}
                  placeholder={translate(
                    'auto.components.settings.SshTargetForm.b8dab0aa7b',
                    'My Server'
                  )}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ssh-target-host">
                  {translate(
                    'auto.components.settings.SshTargetForm.ce370ce674',
                    'Host or alias *'
                  )}
                </Label>
                <Input
                  id="ssh-target-host"
                  value={form.host}
                  autoFocus
                  onChange={(e) => onFormChange((f) => ({ ...f, host: e.target.value }))}
                  onBlur={() => onFormChange(applyParsedSshHostInput)}
                  placeholder={translate(
                    'auto.components.settings.SshTargetForm.2ee9bcd2e8',
                    'server, deploy@server:2222, ssh://server'
                  )}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ssh-target-username">
                  {translate('auto.components.settings.SshTargetForm.dc1dc52aaa', 'Username')}
                </Label>
                <Input
                  id="ssh-target-username"
                  value={form.username}
                  onChange={(e) => onFormChange((f) => ({ ...f, username: e.target.value }))}
                  placeholder={translate(
                    'auto.components.settings.SshTargetForm.47e082bc17',
                    'deploy'
                  )}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ssh-target-port">
                  {translate('auto.components.settings.SshTargetForm.c94cfa634c', 'Port')}
                </Label>
                <Input
                  id="ssh-target-port"
                  type="number"
                  value={form.port}
                  onChange={(e) => onFormChange((f) => ({ ...f, port: e.target.value }))}
                  placeholder="22"
                  min={1}
                  max={65535}
                />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="ssh-target-identity" className="flex items-center gap-1.5">
                  <FileKey className="size-3.5" />
                  {translate('auto.components.settings.SshTargetForm.63c0c145c1', 'Identity File')}
                </Label>
                <Input
                  id="ssh-target-identity"
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
          </div>

          <DialogFooter className="shrink-0 gap-2 border-t border-border/60 bg-muted/10 px-6 py-4 sm:justify-end">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {translate('auto.components.settings.SshTargetForm.fea9cb402e', 'Cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {isEditing
                ? translate('auto.components.settings.SshTargetForm.a62b4cb39a', 'Save Changes')
                : translate('auto.components.settings.SshTargetForm.9518545cb6', 'Add Target')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

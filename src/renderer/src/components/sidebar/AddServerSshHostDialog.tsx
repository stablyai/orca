import { useState } from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useAppStore } from '@/store'
import { EMPTY_FORM, type EditingTarget } from '../settings/ssh-target-draft'
import {
  addRuntimeSshTarget,
  listRuntimeEditableSshTargets
} from '@/runtime/runtime-ssh-target-management'
import { refreshRuntimeEnvironmentSshTargetMetadata } from '@/runtime/runtime-environment-ssh-state'
import { AddRemoteHostSshFormPanel } from './AddRemoteHostSshFormPanel'
import { saveNewSshHostFromForm } from './add-remote-host-ssh-actions'

/** Adds an SSH host to a paired server's own list; nothing is saved on this client. */
export function AddServerSshHostDialog({
  environmentId,
  serverLabel,
  open,
  onOpenChange,
  onSaved
}: {
  environmentId: string
  serverLabel: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}): React.JSX.Element {
  const [form, setForm] = useState<EditingTarget>(EMPTY_FORM)
  const [isSaving, setIsSaving] = useState(false)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)

  const close = (): void => {
    if (isSaving) {
      return
    }
    setForm(EMPTY_FORM)
    onOpenChange(false)
  }

  const save = async (): Promise<void> => {
    setIsSaving(true)
    try {
      const outcome = await saveNewSshHostFromForm({
        form,
        ssh: {
          listTargets: () => listRuntimeEditableSshTargets(environmentId),
          addTarget: ({ target }) => addRuntimeSshTarget(environmentId, target)
        },
        // Why: re-adopted projects live on the server, which announces its own repo change.
        recordSshRepoReadoptions: () => {},
        setSshTargetsMetadata: () => {
          void refreshRuntimeEnvironmentSshTargetMetadata(environmentId).catch(() => {})
        },
        recordFeatureInteraction
      })
      if (outcome === 'saved') {
        setForm(EMPTY_FORM)
        onOpenChange(false)
        onSaved()
      }
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-xl">
        <AddRemoteHostSshFormPanel
          form={form}
          disabled={isSaving}
          preferAdvancedOpen={false}
          configIdentityAlias={null}
          onFormChange={setForm}
          onSubmit={() => void save()}
          onCancel={close}
          serverLabel={serverLabel}
        />
      </DialogContent>
    </Dialog>
  )
}

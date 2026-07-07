import { useState } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  EMPTY_FORM,
  getSshTargetDraftConnectionFields,
  isRelayGracePeriodValid,
  parseRelayGracePeriodSeconds,
  type EditingTarget
} from '../settings/ssh-target-draft'
import { MAX_SSH_RELAY_GRACE_PERIOD_SECONDS, type SshTarget } from '../../../../shared/ssh-types'
import { RemoteServerFields, SshHostFields } from './AddRemoteHostFields'

export type AddRemoteHostMode = 'ssh' | 'server'

type AddRemoteHostDialogProps = {
  mode: AddRemoteHostMode | null
  onOpenChange: (mode: AddRemoteHostMode | null) => void
}

export function AddRemoteHostDialog({
  mode,
  onOpenChange
}: AddRemoteHostDialogProps): React.JSX.Element {
  const open = mode !== null
  const [sshForm, setSshForm] = useState<EditingTarget>(EMPTY_FORM)
  const [serverName, setServerName] = useState('')
  const [pairingCode, setPairingCode] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const setSshTargetsMetadata = useAppStore((s) => s.setSshTargetsMetadata)
  const setRuntimeEnvironments = useAppStore((s) => s.setRuntimeEnvironments)
  const refreshRuntimeEnvironmentStatus = useAppStore((s) => s.refreshRuntimeEnvironmentStatus)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)

  const close = () => {
    if (isSaving || isImporting) {
      return
    }
    onOpenChange(null)
  }

  const reset = () => {
    setSshForm(EMPTY_FORM)
    setServerName('')
    setPairingCode('')
  }

  const refreshSshTargetMetadata = async () => {
    const targets = (await window.api.ssh.listTargets()) as SshTarget[]
    setSshTargetsMetadata(targets)
  }

  const saveSshHost = async () => {
    const { host, configHost, username, port } = getSshTargetDraftConnectionFields(sshForm)
    if (!host) {
      toast.error(
        translate(
          'auto.components.sidebar.AddRemoteHostDialog.sshHostRequired',
          'Host or SSH config alias is required.'
        )
      )
      return
    }
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      toast.error(
        translate(
          'auto.components.sidebar.AddRemoteHostDialog.sshPortInvalid',
          'Port must be between 1 and 65535.'
        )
      )
      return
    }
    const graceSeconds = parseRelayGracePeriodSeconds(sshForm)
    if (!isRelayGracePeriodValid(sshForm, graceSeconds)) {
      toast.error(
        translate(
          'auto.components.sidebar.AddRemoteHostDialog.sshRelayGraceInvalid',
          'Terminal timeout must be between 60 and {{value0}} seconds.',
          { value0: MAX_SSH_RELAY_GRACE_PERIOD_SECONDS }
        )
      )
      return
    }

    const identityFile = sshForm.identityFile.trim() || undefined
    const target = {
      label: sshForm.label.trim() || (username ? `${username}@${host}` : configHost),
      configHost,
      host,
      port,
      username,
      relayGracePeriodSeconds: graceSeconds,
      ...(identityFile ? { identityFile } : {})
    }

    setIsSaving(true)
    try {
      await window.api.ssh.addTarget({ target })
      await refreshSshTargetMetadata()
      recordFeatureInteraction('ssh')
      toast.success(
        translate('auto.components.sidebar.AddRemoteHostDialog.sshSaved', 'SSH host added.')
      )
      reset()
      onOpenChange(null)
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.sidebar.AddRemoteHostDialog.sshSaveFailed',
              'Failed to add SSH host.'
            )
      )
    } finally {
      setIsSaving(false)
    }
  }

  const importSshConfig = async () => {
    setIsImporting(true)
    try {
      const synced = (await window.api.ssh.importConfig()) as SshTarget[]
      await refreshSshTargetMetadata()
      recordFeatureInteraction('ssh')
      if (synced.length === 0) {
        toast(
          translate(
            'auto.components.sidebar.AddRemoteHostDialog.sshImportAlreadySynced',
            '~/.ssh/config already in sync.'
          )
        )
      } else {
        toast.success(
          translate(
            'auto.components.sidebar.AddRemoteHostDialog.sshImportSynced',
            'Synced {{value0}} host{{value1}}.',
            { value0: synced.length, value1: synced.length > 1 ? 's' : '' }
          )
        )
        reset()
        onOpenChange(null)
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.sidebar.AddRemoteHostDialog.sshImportFailed',
              'Failed to import SSH config.'
            )
      )
    } finally {
      setIsImporting(false)
    }
  }

  const saveRemoteServer = async () => {
    const trimmedName = serverName.trim()
    const trimmedPairingCode = pairingCode.trim()
    if (!trimmedName || !trimmedPairingCode) {
      toast.error(
        translate(
          'auto.components.sidebar.AddRemoteHostDialog.serverFieldsRequired',
          'Server name and pairing code are required.'
        )
      )
      return
    }

    setIsSaving(true)
    try {
      const result = await window.api.runtimeEnvironments.addFromPairingCode({
        name: trimmedName,
        pairingCode: trimmedPairingCode
      })
      const environments = await window.api.runtimeEnvironments.list()
      setRuntimeEnvironments(environments)
      await refreshRuntimeEnvironmentStatus(result.environment.id)
      toast.success(
        translate('auto.components.sidebar.AddRemoteHostDialog.serverSaved', 'Remote server added.')
      )
      reset()
      onOpenChange(null)
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.sidebar.AddRemoteHostDialog.serverSaveFailed',
              'Failed to add remote server.'
            )
      )
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          close()
        }
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {mode === 'server'
              ? translate(
                  'auto.components.sidebar.AddRemoteHostDialog.serverTitle',
                  'Add remote server'
                )
              : translate('auto.components.sidebar.AddRemoteHostDialog.sshTitle', 'Add SSH host')}
          </DialogTitle>
          <DialogDescription>
            {mode === 'server'
              ? translate(
                  'auto.components.sidebar.AddRemoteHostDialog.serverDescription',
                  'Pair with Orca running on another computer.'
                )
              : translate(
                  'auto.components.sidebar.AddRemoteHostDialog.sshDescription',
                  'Add a persistent machine you can log into over SSH.'
                )}
          </DialogDescription>
        </DialogHeader>

        {mode === 'server' ? (
          <RemoteServerFields
            name={serverName}
            pairingCode={pairingCode}
            disabled={isSaving}
            onNameChange={setServerName}
            onPairingCodeChange={setPairingCode}
            onSubmit={() => void saveRemoteServer()}
          />
        ) : (
          <SshHostFields
            form={sshForm}
            disabled={isSaving}
            onFormChange={setSshForm}
            onSubmit={() => void saveSshHost()}
          />
        )}

        <DialogFooter className="sm:justify-between">
          {mode === 'ssh' ? (
            <button
              type="button"
              className="self-center text-left text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void importSshConfig()}
              disabled={isSaving || isImporting}
            >
              {isImporting
                ? translate('auto.components.sidebar.AddRemoteHostDialog.importing', 'Importing...')
                : translate(
                    'auto.components.sidebar.AddRemoteHostDialog.importSshConfig',
                    'or import ~/.ssh/config'
                  )}
            </button>
          ) : (
            <span />
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={close}
              disabled={isSaving || isImporting}
            >
              {translate('auto.components.sidebar.AddRemoteHostDialog.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              onClick={mode === 'server' ? () => void saveRemoteServer() : () => void saveSshHost()}
              disabled={isSaving || isImporting}
            >
              {isSaving
                ? translate('auto.components.sidebar.AddRemoteHostDialog.saving', 'Saving...')
                : translate('auto.components.sidebar.AddRemoteHostDialog.save', 'Save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

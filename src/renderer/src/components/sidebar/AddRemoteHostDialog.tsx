import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { EMPTY_FORM, type EditingTarget } from '../settings/ssh-target-draft'
import type { SshConfigHostSummary } from '../../../../shared/ssh-types'
import { parseHostAccessLink } from '../../../../shared/remote-pairing-address'
import {
  translateHostAccessLinkError,
  translateRemotePairingFailureDescription
} from '@/lib/remote-pairing-copy'
import { AddRemoteHostSshConfigPicker } from './AddRemoteHostSshConfigPicker'
import { AddRemoteHostSshFormPanel } from './AddRemoteHostSshFormPanel'
import { AddRemoteHostServerFormPanel } from './AddRemoteHostServerFormPanel'
import {
  addAllSshConfigHostsToOrca,
  loadSshConfigHostsForPicker,
  prefillFormFromSshConfigHost,
  saveNewSshHostFromForm
} from './add-remote-host-ssh-actions'

export type AddRemoteHostMode = 'ssh' | 'server'

type AddRemoteHostDialogProps = {
  mode: AddRemoteHostMode | null
  onOpenChange: (mode: AddRemoteHostMode | null) => void
}

type SshDialogView = 'form' | 'config-picker'

export function AddRemoteHostDialog({
  mode,
  onOpenChange
}: AddRemoteHostDialogProps): React.JSX.Element {
  const open = mode !== null
  // Why: `mode` drives both open-state and which form renders. On close it goes null while the
  // dialog is still animating out, so the title/fields would flash to the SSH default. Latch the
  // last non-null mode for rendering so the closing dialog keeps showing what the user saw.
  const [renderMode, setRenderMode] = useState<AddRemoteHostMode>(mode ?? 'ssh')
  if (mode !== null && mode !== renderMode) {
    setRenderMode(mode)
  }
  const [sshForm, setSshForm] = useState<EditingTarget>(EMPTY_FORM)
  const [sshView, setSshView] = useState<SshDialogView>('form')
  const [configHosts, setConfigHosts] = useState<SshConfigHostSummary[]>([])
  const [configHostCount, setConfigHostCount] = useState(0)
  const [newConfigHostCount, setNewConfigHostCount] = useState(0)
  const [configHostMatchesTruncated, setConfigHostMatchesTruncated] = useState(false)
  const [isLoadingConfigHosts, setIsLoadingConfigHosts] = useState(false)
  const [resolvingConfigAlias, setResolvingConfigAlias] = useState<string | null>(null)
  const [isBulkImporting, setIsBulkImporting] = useState(false)
  const [configHostsError, setConfigHostsError] = useState<string | null>(null)
  const [preferAdvancedOpen, setPreferAdvancedOpen] = useState(false)
  const [configFilledAlias, setConfigFilledAlias] = useState<string | null>(null)
  const [serverName, setServerName] = useState('')
  const [pairingCode, setPairingCode] = useState('')
  const [allowLoopback, setAllowLoopback] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const configSearchGeneration = useRef(0)
  const configSearchQuery = useRef('')
  const configResolveGeneration = useRef(0)
  const parsedServerLink = useMemo(() => parseHostAccessLink(pairingCode), [pairingCode])
  const serverFormCanSubmit =
    serverName.trim() !== '' &&
    parsedServerLink.ok &&
    (parsedServerLink.value.endpointKind !== 'loopback' || allowLoopback)
  const setSshTargetsMetadata = useAppStore((s) => s.setSshTargetsMetadata)
  const recordSshRepoReadoptions = useAppStore((s) => s.recordSshRepoReadoptions)
  const setRuntimeEnvironments = useAppStore((s) => s.setRuntimeEnvironments)
  const setRuntimeEnvironmentStatus = useAppStore((s) => s.setRuntimeEnvironmentStatus)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)

  const busy = isSaving || isBulkImporting || resolvingConfigAlias !== null

  // Why: a pending resolve must never write into a form the user has moved on from.
  const invalidatePendingConfigResolve = () => {
    configResolveGeneration.current += 1
    setResolvingConfigAlias(null)
  }

  const reset = () => {
    setSshForm(EMPTY_FORM)
    setSshView('form')
    setConfigHosts([])
    setConfigHostCount(0)
    setNewConfigHostCount(0)
    setConfigHostMatchesTruncated(false)
    setConfigHostsError(null)
    configSearchQuery.current = ''
    invalidatePendingConfigResolve()
    setPreferAdvancedOpen(false)
    setConfigFilledAlias(null)
    setIsBulkImporting(false)
    setServerName('')
    setPairingCode('')
    setAllowLoopback(false)
  }

  const close = () => {
    // Why: a stuck resolve must not trap the dialog open — reset() invalidates it instead.
    if (isSaving || isBulkImporting) {
      return
    }
    reset()
    onOpenChange(null)
  }

  const saveSshHost = async () => {
    setIsSaving(true)
    try {
      const outcome = await saveNewSshHostFromForm({
        form: sshForm,
        ssh: window.api.ssh,
        recordSshRepoReadoptions,
        setSshTargetsMetadata,
        recordFeatureInteraction
      })
      if (outcome === 'saved') {
        reset()
        onOpenChange(null)
      }
    } finally {
      setIsSaving(false)
    }
  }

  const loadSshConfigHosts = async (query = '', options?: { refresh?: boolean }) => {
    configSearchQuery.current = query
    const generation = configSearchGeneration.current + 1
    configSearchGeneration.current = generation
    setIsLoadingConfigHosts(true)
    setConfigHostsError(null)
    const result = await loadSshConfigHostsForPicker(window.api.ssh, {
      query,
      ...(options?.refresh ? { refresh: true } : {})
    })
    if (generation !== configSearchGeneration.current) {
      return
    }
    if (result.ok) {
      setConfigHosts(result.result.hosts)
      setConfigHostCount(result.result.totalHostCount)
      setNewConfigHostCount(result.result.newHostCount)
      setConfigHostMatchesTruncated(result.result.hasMore)
    } else {
      setConfigHosts([])
      setConfigHostsError(result.error)
    }
    setIsLoadingConfigHosts(false)
  }

  const openSshConfigPicker = async () => {
    setSshView('config-picker')
    // Why: re-read ~/.ssh/config on open; the filter keystrokes reuse that parse.
    await loadSshConfigHosts('', { refresh: true })
  }

  const leaveSshConfigPicker = () => {
    invalidatePendingConfigResolve()
    setSshView('form')
  }

  const selectSshConfigHost = async (host: SshConfigHostSummary) => {
    const generation = configResolveGeneration.current + 1
    configResolveGeneration.current = generation
    setResolvingConfigAlias(host.alias)
    // Why: a slower earlier pick must not overwrite the host the user settled on.
    const isStale = () => generation !== configResolveGeneration.current
    let resolved: Awaited<ReturnType<typeof prefillFormFromSshConfigHost>>
    try {
      resolved = await prefillFormFromSshConfigHost(host, window.api.ssh)
    } catch (error) {
      if (isStale()) {
        return
      }
      setResolvingConfigAlias(null)
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerResolveFailed',
              'Failed to resolve that SSH config host.'
            )
      )
      return
    }
    if (isStale()) {
      return
    }
    setResolvingConfigAlias(null)
    if (!resolved) {
      toast.error(
        translate(
          'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerResolveFailed',
          'Failed to resolve that SSH config host.'
        )
      )
      return
    }
    const { form, preferAdvancedOpen: openAdvanced } = resolved
    setSshForm(form)
    setPreferAdvancedOpen(openAdvanced)
    setConfigFilledAlias(host.alias)
    setSshView('form')
    recordFeatureInteraction('ssh')
    toast.success(
      translate(
        'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerFilled',
        'Filled from {{value0}}. Review and Save.',
        { value0: host.alias }
      )
    )
  }

  const addAllConfigHostsToOrca = async () => {
    setIsBulkImporting(true)
    try {
      const result = await addAllSshConfigHostsToOrca({
        ssh: window.api.ssh,
        recordSshRepoReadoptions,
        setSshTargetsMetadata,
        recordFeatureInteraction
      })
      if (result.kind === 'added') {
        reset()
        onOpenChange(null)
        return
      }
      if (result.kind === 'already-synced') {
        // Why: reuse the loader so the refresh keeps the active filter and stays inside the
        // generation guard against an in-flight debounced search.
        await loadSshConfigHosts(configSearchQuery.current)
      }
    } finally {
      setIsBulkImporting(false)
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
    if (!parsedServerLink.ok) {
      toast.error(translateHostAccessLinkError(parsedServerLink.kind))
      return
    }
    if (parsedServerLink.value.endpointKind === 'loopback' && !allowLoopback) {
      toast.error(
        translate(
          'auto.components.sidebar.AddRemoteHostDialog.loopbackBlocked',
          'Enable the SSH tunnel override or create a new link using the other host’s Tailscale or LAN address.'
        )
      )
      return
    }

    setIsSaving(true)
    try {
      const result = await window.api.runtimeEnvironments.verifyAndAddFromPairingCode({
        name: trimmedName,
        pairingCode: trimmedPairingCode,
        allowLoopback
      })
      if (!result.ok) {
        toast.error(
          result.kind === 'environment-save-failed'
            ? result.message
            : translateRemotePairingFailureDescription(
                result.kind,
                parsedServerLink.value.displayEndpoint
              )
        )
        return
      }
      const environments = await window.api.runtimeEnvironments.list()
      setRuntimeEnvironments(environments)
      setRuntimeEnvironmentStatus(result.environment.id, {
        status: result.runtimeStatus,
        checkedAt: Date.now()
      })
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

  const showSshConfigPicker = renderMode === 'ssh' && sshView === 'config-picker'

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          close()
        }
      }}
    >
      <DialogContent
        className={
          showSshConfigPicker
            ? 'flex max-h-[min(90vh,560px)] flex-col gap-0 overflow-hidden sm:max-w-xl'
            : 'scrollbar-sleek max-h-[min(90vh,560px)] overflow-y-auto sm:max-w-xl'
        }
      >
        {showSshConfigPicker ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <AddRemoteHostSshConfigPicker
              hosts={configHosts}
              totalHostCount={configHostCount}
              newHostCount={newConfigHostCount}
              matchesTruncated={configHostMatchesTruncated}
              isLoading={isLoadingConfigHosts}
              isBulkImporting={isBulkImporting}
              resolvingAlias={resolvingConfigAlias}
              loadError={configHostsError}
              onSelect={(host) => void selectSshConfigHost(host)}
              onQueryChange={(query) => void loadSshConfigHosts(query)}
              onRetry={() => void loadSshConfigHosts(configSearchQuery.current, { refresh: true })}
              onBack={leaveSshConfigPicker}
              onAddAllToOrca={() => void addAllConfigHostsToOrca()}
            />
          </div>
        ) : renderMode === 'ssh' ? (
          <AddRemoteHostSshFormPanel
            form={sshForm}
            disabled={busy}
            preferAdvancedOpen={preferAdvancedOpen}
            configIdentityAlias={configFilledAlias}
            onFormChange={setSshForm}
            onSubmit={() => void saveSshHost()}
            onCancel={close}
            onFillFromConfig={() => void openSshConfigPicker()}
          />
        ) : (
          <AddRemoteHostServerFormPanel
            name={serverName}
            pairingCode={pairingCode}
            parsedLink={parsedServerLink}
            allowLoopback={allowLoopback}
            disabled={busy}
            canSubmit={serverFormCanSubmit}
            onNameChange={setServerName}
            onPairingCodeChange={(value) => {
              setPairingCode(value)
              setAllowLoopback(false)
            }}
            onAllowLoopbackChange={setAllowLoopback}
            onSubmit={() => void saveRemoteServer()}
            onCancel={close}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { EphemeralVmRuntimesSection } from './EphemeralVmRuntimesSection'
import {
  getRuntimeEnvironmentsSearchEntry,
  getWebRuntimeEnvironmentsSearchEntry
} from './runtime-environments-search'
import { isRuntimeEnvironmentRemovalBlocked } from './runtime-environment-host-details'
import {
  RuntimeEnvironmentRemoveDialog,
  RuntimeEnvironmentSwitchDialog
} from './runtime-environment-dialogs'
import { RuntimeAddServerDialog } from './runtime-add-server-dialog'
import { RuntimeDefaultHostRow } from './runtime-default-host-row'
import { RuntimeInstallServerDialog } from './runtime-install-server-dialog'
import { RuntimeServerList } from './runtime-server-list'
import { useRuntimeServersPage } from './runtime-servers-page-context'
import { WslHostsSection } from './WslHostsSection'
import { useManagedServerCatalog } from './use-managed-server-catalog'
import { useRuntimeEnvironmentCatalog } from './use-runtime-environment-catalog'
import { useRuntimeEnvironmentConnectionActions } from './use-runtime-environment-connection-actions'
import { useRuntimeEnvironmentMutationActions } from './use-runtime-environment-mutation-actions'
import { LOCAL_RUNTIME_VALUE, NO_RUNTIME_VALUE } from './runtime-environment-selection'

export {
  evaluateHostDetails,
  getActiveServerModeDescription,
  getHostDetailsDescription,
  getHostDetailsSummary,
  getHostModelCapabilitySummary,
  getRuntimeCapabilitiesSummary,
  getRuntimeServerConnectionState,
  isRuntimeServerTransportConnected,
  isRuntimeEnvironmentRemovalBlocked
} from './runtime-environment-host-details'
export type { RuntimeHostDetails } from './runtime-environment-host-details'

type RuntimeEnvironmentsPaneProps = {
  settings: GlobalSettings
  setActiveRuntimeEnvironmentPreference: (environmentId: string | null) => Promise<boolean>
  canGeneratePairingUrl?: boolean
  allowLocalRuntime?: boolean
  addServerIntentSignal?: number
}

export function RuntimeEnvironmentsPane({
  settings,
  setActiveRuntimeEnvironmentPreference,
  canGeneratePairingUrl = true,
  allowLocalRuntime = true,
  addServerIntentSignal
}: RuntimeEnvironmentsPaneProps): React.JSX.Element {
  const { dialog, setDialog } = useRuntimeServersPage()
  const [pendingSwitchValue, setPendingSwitchValue] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<PublicKnownRuntimeEnvironment | null>(null)
  const remoteServerUpdates = useAppStore((state) => state.remoteServerUpdates)
  const remoteServerUpdatesRunning = useAppStore((state) => state.remoteServerUpdatesRunning)
  const refreshRemoteServerUpdates = useAppStore((state) => state.refreshRemoteServerUpdates)
  const setRemoteServerUpdateDialogOpen = useAppStore(
    (state) => state.setRemoteServerUpdateDialogOpen
  )
  const consumedAddServerIntentSignalRef = useRef(0)
  const {
    environments,
    isLoading,
    detailsByEnvironmentId,
    setDetailsByEnvironmentId,
    mountedRef,
    loadEnvironments
  } = useRuntimeEnvironmentCatalog()
  const managedCatalog = useManagedServerCatalog(environments, () => void loadEnvironments())

  const getEnvironmentLabel = (value: string): string => {
    if (value === LOCAL_RUNTIME_VALUE) {
      return translate('auto.components.settings.serverList.thisComputer', 'This computer')
    }
    if (value === NO_RUNTIME_VALUE) {
      return translate(
        'auto.components.settings.RuntimeEnvironmentsPane.b07070ed3c',
        'No server connected'
      )
    }
    // Why the store: the default may be a WSL host, which the listed servers leave out.
    return (
      useAppStore.getState().runtimeEnvironments.find((environment) => environment.id === value)
        ?.name ?? 'remote server'
    )
  }
  const {
    connectingId,
    switchingValue,
    disconnectingId,
    switchError,
    setSwitchError,
    connectEnvironment,
    disconnectEnvironment,
    switchToValue
  } = useRuntimeEnvironmentConnectionActions({
    allowLocalRuntime,
    mountedRef,
    setDetailsByEnvironmentId,
    setActiveRuntimeEnvironmentPreference,
    getEnvironmentLabel
  })
  const {
    isSaving,
    removingId,
    removeError,
    setRemoveError,
    name,
    setName,
    pairingCode,
    setPairingCode,
    addServerFailure,
    setAddServerFailure,
    closeAddServerForm,
    addEnvironment,
    removeEnvironment
  } = useRuntimeEnvironmentMutationActions({
    settings,
    allowLocalRuntime,
    mountedRef,
    setAddServerFormOpen: (open) => setDialog(open ? 'add' : null),
    loadEnvironments,
    connectEnvironment
  })

  const environmentIdsKey = environments.map((environment) => environment.id).join('\n')
  useEffect(() => {
    void refreshRemoteServerUpdates()
  }, [environmentIdsKey, refreshRemoteServerUpdates])
  useEffect(() => {
    if (
      !addServerIntentSignal ||
      consumedAddServerIntentSignalRef.current === addServerIntentSignal
    ) {
      return
    }
    consumedAddServerIntentSignalRef.current = addServerIntentSignal
    // Why: composer deep-links should land on the pairing form, not just the server list.
    setDialog('add')
  }, [addServerIntentSignal, setDialog])
  const managedReload = managedCatalog.reload
  useEffect(() => {
    // Why: SSH hosts and unfinished moves change on the SSH Hosts page while this one is mounted.
    if (dialog === 'install') {
      void managedReload().catch(() => {})
    }
  }, [dialog, managedReload])

  const activeValue =
    settings.activeRuntimeEnvironmentId ??
    (allowLocalRuntime ? LOCAL_RUNTIME_VALUE : NO_RUNTIME_VALUE)
  const isBusy =
    isSaving ||
    connectingId !== null ||
    switchingValue !== null ||
    removingId !== null ||
    disconnectingId !== null
  const removingActiveServer = pendingRemove
    ? isRuntimeEnvironmentRemovalBlocked(settings.activeRuntimeEnvironmentId, pendingRemove.id)
    : false
  const searchEntry = canGeneratePairingUrl
    ? getRuntimeEnvironmentsSearchEntry()
    : getWebRuntimeEnvironmentsSearchEntry()
  const reloadAll = (): void => {
    void loadEnvironments()
    void managedCatalog.reload().catch(() => {})
  }

  const confirmSwitch = (): void => {
    const value = pendingSwitchValue
    if (!value) {
      return
    }
    void switchToValue(value).then((switched) => {
      if (switched && mountedRef.current) {
        setPendingSwitchValue(null)
      }
    })
  }
  const requestSwitch = (value: string): void => {
    setSwitchError(null)
    setPendingSwitchValue(value)
  }
  const confirmRemove = (): void => {
    const environment = pendingRemove
    if (!environment) {
      return
    }
    void removeEnvironment(environment).then((removed) => {
      if (removed && mountedRef.current) {
        setPendingRemove(null)
      }
    })
  }

  return (
    <SearchableSetting
      title={searchEntry.title}
      description={searchEntry.description}
      keywords={searchEntry.keywords}
      className="max-w-none space-y-6"
    >
      <RuntimeDefaultHostRow
        allowLocalRuntime={allowLocalRuntime}
        activeValue={activeValue}
        environments={environments}
        isBusy={isBusy}
        onValueChange={requestSwitch}
      />

      <RuntimeServerList
        environments={environments}
        detailsByEnvironmentId={detailsByEnvironmentId}
        activeRuntimeEnvironmentId={settings.activeRuntimeEnvironmentId}
        remoteServerUpdates={remoteServerUpdates}
        remoteServerUpdatesRunning={remoteServerUpdatesRunning}
        connectingId={connectingId}
        switchingValue={switchingValue}
        disconnectingId={disconnectingId}
        removingId={removingId}
        isBusy={isBusy}
        managedCatalog={managedCatalog}
        onOpenUpdate={() => setRemoteServerUpdateDialogOpen(true)}
        onConnect={(environment) => void connectEnvironment(environment)}
        onDisconnect={(environment) => void disconnectEnvironment(environment)}
        onRemove={(environment) => {
          setRemoveError(null)
          setPendingRemove(environment)
        }}
        onMakeDefault={(environment) => requestSwitch(environment.id)}
        onCheckForUpdates={(options) => {
          setRemoteServerUpdateDialogOpen(true)
          void refreshRemoteServerUpdates(options)
        }}
        onRecheck={() => void loadEnvironments()}
        rechecking={isLoading}
        onChanged={reloadAll}
      />

      {managedCatalog.loadFailed ? (
        <p className="text-xs text-destructive">
          {translate(
            'auto.components.settings.managedServers.loadFailed',
            'Orca couldn’t load SSH hosts and unfinished moves. Reopen Settings to try again.'
          )}
        </p>
      ) : null}

      {/* Why gated on the managed API: WSL hosts, like managed servers, need the desktop. */}
      {managedCatalog.api ? <WslHostsSection onChanged={reloadAll} /> : null}

      <EphemeralVmRuntimesSection />

      <RuntimeAddServerDialog
        open={dialog === 'add'}
        name={name}
        accessLink={pairingCode}
        busy={isBusy}
        failure={addServerFailure}
        onNameChange={setName}
        onAccessLinkChange={(value) => {
          setPairingCode(value)
          setAddServerFailure(null)
        }}
        onClose={closeAddServerForm}
        onSubmit={(allowLoopback) => void addEnvironment(allowLoopback)}
      />

      {managedCatalog.api ? (
        <RuntimeInstallServerDialog
          open={dialog === 'install'}
          api={managedCatalog.api}
          emptyTargets={managedCatalog.emptyTargets}
          loadFailed={managedCatalog.loadFailed}
          onOpenChange={(open) => setDialog(open ? 'install' : null)}
          onDeployed={async () => {
            void loadEnvironments()
            await managedCatalog.reload()
          }}
        />
      ) : null}

      <RuntimeEnvironmentSwitchDialog
        pendingSwitchValue={pendingSwitchValue}
        switchingValue={switchingValue}
        switchError={switchError}
        getEnvironmentLabel={getEnvironmentLabel}
        onOpenChange={(open) => {
          if (!open && switchingValue === null) {
            setSwitchError(null)
            setPendingSwitchValue(null)
          }
        }}
        onCancel={() => {
          setSwitchError(null)
          setPendingSwitchValue(null)
        }}
        onConfirm={confirmSwitch}
      />

      <RuntimeEnvironmentRemoveDialog
        pendingRemove={pendingRemove}
        removingId={removingId}
        removeError={removeError}
        removingActiveServer={removingActiveServer}
        onOpenChange={(open) => {
          if (!open && removingId === null) {
            setRemoveError(null)
            setPendingRemove(null)
          }
        }}
        onCancel={() => {
          setRemoveError(null)
          setPendingRemove(null)
        }}
        onConfirm={confirmRemove}
      />
    </SearchableSetting>
  )
}

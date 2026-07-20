/* eslint-disable max-lines -- Why: the server settings pane keeps active
   server selection, saved server mutation, and confirmation dialogs together so
   the state transitions stay auditable. */
import {
  AlertTriangle,
  ChevronDown,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  ServerOff,
  Share2,
  Trash2
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { GlobalSettings } from '../../../../shared/types'
import {
  isUserManagedRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import {
  describeRuntimeCompatBlock,
  evaluateRuntimeCompat,
  type RuntimeCompatVerdict
} from '../../../../shared/protocol-compat'
import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  RUNTIME_PROTOCOL_VERSION,
  TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { RuntimePairingUrlGenerator } from './RuntimePairingUrlGenerator'
import { EphemeralVmRuntimesSection } from './EphemeralVmRuntimesSection'
import {
  getRuntimeEnvironmentsSearchEntry,
  getWebRuntimeEnvironmentsSearchEntry
} from './runtime-environments-search'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

const LOCAL_RUNTIME_VALUE = '__local__'
const NO_RUNTIME_VALUE = '__none__'

type RuntimeEnvironmentsPaneProps = {
  settings: GlobalSettings
  switchRuntimeEnvironment: (environmentId: string | null) => Promise<boolean>
  canGeneratePairingUrl?: boolean
  allowLocalRuntime?: boolean
}

export type RuntimeHostDetails = {
  status: 'loading' | 'ready' | 'error'
  runtimeStatus: RuntimeStatus | null
  compatibility: RuntimeCompatVerdict | null
  error: string | null
}

export function evaluateHostDetails(status: RuntimeStatus): RuntimeCompatVerdict {
  return evaluateRuntimeCompat({
    clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
    serverProtocolVersion: status.runtimeProtocolVersion ?? status.protocolVersion,
    serverMinCompatibleClientProtocolVersion:
      status.minCompatibleRuntimeClientVersion ?? status.minCompatibleMobileVersion
  })
}

export function getHostDetailsSummary(details: RuntimeHostDetails | undefined): string {
  if (!details || details.status === 'loading') {
    return translate('auto.components.settings.RuntimeEnvironmentsPane.5120beaac6', 'Checking…')
  }
  if (details.status === 'error') {
    return translate(
      'auto.components.settings.RuntimeEnvironmentsPane.c8791efc45',
      'Status unavailable'
    )
  }
  if (details.compatibility?.kind === 'blocked') {
    return details.compatibility.reason === 'client-too-old'
      ? translate('auto.components.settings.RuntimeEnvironmentsPane.62ac182a27', 'Update client')
      : translate('auto.components.settings.RuntimeEnvironmentsPane.86ed75bec8', 'Update server')
  }
  return translate('auto.components.settings.RuntimeEnvironmentsPane.9a91c4a0eb', 'Compatible')
}

export function getHostDetailsDescription(details: RuntimeHostDetails | undefined): string | null {
  if (!details || details.status === 'loading') {
    return null
  }
  if (details.status === 'error') {
    return details.error
  }
  if (details.compatibility?.kind === 'blocked') {
    return describeRuntimeCompatBlock(details.compatibility)
  }
  return null
}

export function getRuntimeCapabilitiesSummary(status: RuntimeStatus | null | undefined): string {
  const capabilities = status?.capabilities ?? []
  if (capabilities.length === 0) {
    return translate(
      'auto.components.settings.RuntimeEnvironmentsPane.4b5c6d7e8f',
      'No capabilities reported'
    )
  }
  const visibleCapabilities = capabilities.slice(0, 3).join(', ')
  const hiddenCount = capabilities.length - 3
  return hiddenCount > 0 ? `${visibleCapabilities} +${hiddenCount}` : visibleCapabilities
}

export function getHostModelCapabilitySummary(
  status: RuntimeStatus | null | undefined
): string | null {
  if (!status) {
    return null
  }
  const capabilities = status.capabilities
  if (!capabilities) {
    return translate(
      'auto.components.settings.RuntimeEnvironmentsPane.hostModelCapabilityUnknown',
      'Host model support: checking server capabilities'
    )
  }
  const missing = [
    PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
    TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY,
    WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
  ].filter((capability) => !capabilities.includes(capability))
  if (missing.length === 0) {
    return translate(
      'auto.components.settings.RuntimeEnvironmentsPane.hostModelCapabilitySupported',
      'Host model support: ready'
    )
  }
  const missingLabels = missing.map(getHostModelCapabilityLabel)
  return translate(
    'auto.components.settings.RuntimeEnvironmentsPane.hostModelCapabilityMissing',
    'Host model support: update server for {{value0}}',
    { value0: missingLabels.join(', ') }
  )
}

function getHostModelCapabilityLabel(capability: string): string {
  switch (capability) {
    case PROJECT_HOST_SETUP_RUNTIME_CAPABILITY:
      return translate(
        'auto.components.settings.RuntimeEnvironmentsPane.hostModelCapabilityProjectSetup',
        'project setup'
      )
    case TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY:
      return translate(
        'auto.components.settings.RuntimeEnvironmentsPane.hostModelCapabilityTaskSourceContext',
        'task source context'
      )
    case WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY:
      return translate(
        'auto.components.settings.RuntimeEnvironmentsPane.hostModelCapabilityWorkspaceRunContext',
        'workspace run context'
      )
    default:
      return capability
  }
}

export function getActiveServerModeDescription(allowLocalRuntime: boolean): string {
  return allowLocalRuntime
    ? translate(
        'auto.components.settings.RuntimeEnvironmentsPane.3f67e8078a',
        'Use this computer by default. Choose a saved server only when you want supported projects, files, terminals, provider checks, and browser/mobile handoff to run through that server.'
      )
    : translate(
        'auto.components.settings.RuntimeEnvironmentsPane.2c85efb3e8',
        'Selecting a saved server makes this browser use that paired Orca runtime as its default Host.'
      )
}

type RuntimeServerConnectionState = 'connected' | 'checking' | 'disconnected'

export function getRuntimeServerConnectionState(
  details: RuntimeHostDetails | undefined
): RuntimeServerConnectionState {
  if (!details || details.status === 'loading') {
    return 'checking'
  }
  if (details.status !== 'ready' || details.compatibility?.kind === 'blocked') {
    return 'disconnected'
  }
  // Why: an attached, reachable, compatible host is "Connected" (and exposes
  // Disconnect). Whether it is the default *active* server is a separate concept,
  // surfaced by the Advanced > Active Server selector and the row's help text —
  // it must not change this connection label, or the dot/label/button disagree.
  return 'connected'
}

function getRuntimeServerConnectionLabel(state: RuntimeServerConnectionState): string {
  switch (state) {
    case 'connected':
      return translate(
        'auto.components.settings.RuntimeEnvironmentsPane.serverConnected',
        'Connected'
      )
    case 'checking':
      return translate(
        'auto.components.settings.RuntimeEnvironmentsPane.serverChecking',
        'Checking…'
      )
    case 'disconnected':
      return translate(
        'auto.components.settings.RuntimeEnvironmentsPane.serverDisconnected',
        'Disconnected'
      )
  }
}

function getRuntimeServerDotClass(state: RuntimeServerConnectionState): string {
  switch (state) {
    case 'connected':
      return 'bg-emerald-500'
    case 'checking':
      return 'bg-yellow-500'
    case 'disconnected':
      return 'bg-muted-foreground/40'
  }
}

export function RuntimeEnvironmentsPane({
  settings,
  switchRuntimeEnvironment,
  canGeneratePairingUrl = true,
  allowLocalRuntime = true
}: RuntimeEnvironmentsPaneProps): React.JSX.Element {
  const [environments, setEnvironments] = useState<PublicKnownRuntimeEnvironment[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [detailsByEnvironmentId, setDetailsByEnvironmentId] = useState<
    Record<string, RuntimeHostDetails>
  >({})
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [switchingValue, setSwitchingValue] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null)
  const [pendingSwitchValue, setPendingSwitchValue] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<PublicKnownRuntimeEnvironment | null>(null)
  const [addServerFormOpen, setAddServerFormOpen] = useState(false)
  const [shareServerFormOpen, setShareServerFormOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [pairingCode, setPairingCode] = useState('')
  const mountedRef = useMountedRef()
  const activeValue =
    settings.activeRuntimeEnvironmentId ??
    (allowLocalRuntime ? LOCAL_RUNTIME_VALUE : NO_RUNTIME_VALUE)
  const isBusy =
    isSaving ||
    connectingId !== null ||
    switchingValue !== null ||
    removingId !== null ||
    disconnectingId !== null
  const removingActiveServer = pendingRemove?.id === settings.activeRuntimeEnvironmentId
  const searchEntry = canGeneratePairingUrl
    ? getRuntimeEnvironmentsSearchEntry()
    : getWebRuntimeEnvironmentsSearchEntry()

  const loadEnvironments = useCallback(async (): Promise<void> => {
    if (mountedRef.current) {
      setIsLoading(true)
    }
    try {
      const nextEnvironments = await window.api.runtimeEnvironments.list()
      const visibleEnvironments = nextEnvironments.filter(isUserManagedRuntimeEnvironment)
      // Why: drop store status for servers no longer saved so stale hosts don't
      // linger in the sidebar registry.
      useAppStore.getState().setRuntimeEnvironments(nextEnvironments)
      if (mountedRef.current) {
        setEnvironments(visibleEnvironments)
        setDetailsByEnvironmentId((current) => {
          const next: Record<string, RuntimeHostDetails> = {}
          for (const environment of visibleEnvironments) {
            next[environment.id] = current[environment.id] ?? {
              status: 'loading',
              runtimeStatus: null,
              compatibility: null,
              error: null
            }
          }
          return next
        })
      }
      await Promise.allSettled(
        visibleEnvironments.map(async (environment) => {
          try {
            const response = await window.api.runtimeEnvironments.getStatus({
              selector: environment.id,
              timeoutMs: 10_000
            })
            const runtimeStatus = unwrapRuntimeRpcResult<RuntimeStatus>(response)
            // Why: feed the live status into the store so sidebar host pickers
            // reflect manual refreshes, not just the settings pane.
            useAppStore.getState().setRuntimeEnvironmentStatus(environment.id, {
              status: runtimeStatus,
              checkedAt: Date.now()
            })
            if (!mountedRef.current) {
              return
            }
            setDetailsByEnvironmentId((current) => ({
              ...current,
              [environment.id]: {
                status: 'ready',
                runtimeStatus,
                compatibility: evaluateHostDetails(runtimeStatus),
                error: null
              }
            }))
          } catch (error) {
            // Why: record the failed probe (null status) so the sidebar can
            // distinguish unreachable from never-checked.
            useAppStore.getState().setRuntimeEnvironmentStatus(environment.id, {
              status: null,
              checkedAt: Date.now()
            })
            if (!mountedRef.current) {
              return
            }
            setDetailsByEnvironmentId((current) => ({
              ...current,
              [environment.id]: {
                status: 'error',
                runtimeStatus: null,
                compatibility: null,
                error: error instanceof Error ? error.message : String(error)
              }
            }))
          }
        })
      )
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.RuntimeEnvironmentsPane.e6410d72c3',
                'Failed to load runtime environments.'
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setIsLoading(false)
      }
    }
  }, [mountedRef])

  useEffect(() => {
    void loadEnvironments()
  }, [loadEnvironments])

  const closeAddServerForm = (): void => {
    if (isSaving) {
      return
    }
    setAddServerFormOpen(false)
    setName('')
    setPairingCode('')
  }

  const addEnvironment = async (): Promise<void> => {
    const trimmedName = name.trim()
    const trimmedPairingCode = pairingCode.trim()
    if (!trimmedName || !trimmedPairingCode) {
      toast.error(
        translate(
          'auto.components.settings.RuntimeEnvironmentsPane.0c55a47480',
          'Name and pairing code are required.'
        )
      )
      return
    }
    const duplicate = environments.find(
      (environment) => environment.name.trim().toLowerCase() === trimmedName.toLowerCase()
    )
    if (duplicate) {
      toast.error(
        translate(
          'auto.components.settings.RuntimeEnvironmentsPane.5ef712f407',
          'A server named "{{value0}}" already exists.',
          { value0: duplicate.name }
        )
      )
      return
    }
    setIsSaving(true)
    try {
      if (!allowLocalRuntime && settings.activeRuntimeEnvironmentId) {
        const disconnected = await switchRuntimeEnvironment(null)
        if (!disconnected) {
          return
        }
      }
      const result = await window.api.runtimeEnvironments.addFromPairingCode({
        name: trimmedName,
        pairingCode: trimmedPairingCode
      })
      if (mountedRef.current) {
        setName('')
        setPairingCode('')
      }
      await loadEnvironments()
      if (!allowLocalRuntime) {
        const switched = await switchRuntimeEnvironment(result.environment.id)
        if (!switched) {
          await window.api.runtimeEnvironments.remove({ selector: result.environment.id })
          await loadEnvironments()
          return
        }
        if (mountedRef.current) {
          toast.success(
            translate(
              'auto.components.settings.RuntimeEnvironmentsPane.a5b58465b6',
              'Connected to {{value0}}.',
              { value0: result.environment.name }
            )
          )
        }
      } else {
        if (mountedRef.current) {
          toast.success(
            translate(
              'auto.components.settings.RuntimeEnvironmentsPane.7b5986c8df',
              'Saved {{value0}}. Use Advanced > Default runtime to make it the default.',
              { value0: result.environment.name }
            )
          )
        }
      }
      if (mountedRef.current) {
        setAddServerFormOpen(false)
      }
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.RuntimeEnvironmentsPane.6cb6eae14f',
                'Failed to save runtime environment.'
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setIsSaving(false)
      }
    }
  }

  const removeEnvironment = async (
    environment: PublicKnownRuntimeEnvironment
  ): Promise<boolean> => {
    setRemovingId(environment.id)
    setRemoveError(null)
    try {
      if (settings.activeRuntimeEnvironmentId === environment.id) {
        const switched = await switchRuntimeEnvironment(null)
        if (!switched) {
          if (mountedRef.current) {
            setRemoveError(
              allowLocalRuntime
                ? 'Could not switch to Local desktop. Fix the issue and try again.'
                : 'Could not disconnect from this server. Fix the issue and try again.'
            )
          }
          return false
        }
        if (!allowLocalRuntime) {
          await loadEnvironments()
          if (mountedRef.current) {
            toast.success(
              translate(
                'auto.components.settings.RuntimeEnvironmentsPane.b5b5114cb0',
                'Removed {{value0}}.',
                { value0: environment.name }
              )
            )
          }
          return true
        }
      }
      await window.api.runtimeEnvironments.remove({ selector: environment.id })
      await loadEnvironments()
      if (mountedRef.current) {
        toast.success(
          translate(
            'auto.components.settings.RuntimeEnvironmentsPane.b5b5114cb0',
            'Removed {{value0}}.',
            { value0: environment.name }
          )
        )
      }
      return true
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to remove runtime environment.'
      if (mountedRef.current) {
        setRemoveError(message)
        toast.error(message)
      }
      return false
    } finally {
      if (mountedRef.current) {
        setRemovingId(null)
      }
    }
  }

  const disconnectEnvironment = async (
    environment: PublicKnownRuntimeEnvironment
  ): Promise<boolean> => {
    setDisconnectingId(environment.id)
    setSwitchError(null)
    try {
      if (settings.activeRuntimeEnvironmentId === environment.id) {
        const switched = await switchRuntimeEnvironment(null)
        if (!switched) {
          if (mountedRef.current) {
            setSwitchError(
              allowLocalRuntime
                ? 'Could not switch to Local desktop. Fix the issue and try again.'
                : 'Could not disconnect from this server. Fix the issue and try again.'
            )
          }
          return false
        }
      }
      await window.api.runtimeEnvironments.disconnect({ selector: environment.id })
      // Why: disconnect is non-destructive; keep the saved server but show the
      // user that this live client is no longer attached to it.
      useAppStore.getState().setRuntimeEnvironmentStatus(environment.id, {
        status: null,
        checkedAt: Date.now()
      })
      if (mountedRef.current) {
        setDetailsByEnvironmentId((current) => ({
          ...current,
          [environment.id]: {
            status: 'error',
            runtimeStatus: null,
            compatibility: null,
            error: null
          }
        }))
        toast.success(
          translate(
            'auto.components.settings.RuntimeEnvironmentsPane.disconnectedServer',
            'Disconnected from {{value0}}.',
            { value0: environment.name }
          )
        )
      }
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to disconnect server.'
      if (mountedRef.current) {
        setSwitchError(message)
        toast.error(message)
      }
      return false
    } finally {
      if (mountedRef.current) {
        setDisconnectingId(null)
      }
    }
  }

  const connectEnvironment = async (
    environment: PublicKnownRuntimeEnvironment
  ): Promise<boolean> => {
    setConnectingId(environment.id)
    setSwitchError(null)
    try {
      const response = await window.api.runtimeEnvironments.getStatus({
        selector: environment.id,
        timeoutMs: 15_000
      })
      const runtimeStatus = unwrapRuntimeRpcResult<RuntimeStatus>(response)
      const compatibility = evaluateHostDetails(runtimeStatus)
      // Why: row Connect is reachability only. The Advanced selector is the
      // explicit default-host control and should be the only active-server path.
      useAppStore.getState().setRuntimeEnvironmentStatus(environment.id, {
        status: runtimeStatus,
        checkedAt: Date.now()
      })
      if (mountedRef.current) {
        setDetailsByEnvironmentId((current) => ({
          ...current,
          [environment.id]: {
            status: 'ready',
            runtimeStatus,
            compatibility,
            error: null
          }
        }))
      }
      if (compatibility.kind === 'blocked') {
        const message = describeRuntimeCompatBlock(compatibility)
        if (mountedRef.current) {
          setSwitchError(message)
          toast.error(message)
        }
        return false
      }
      const store = useAppStore.getState()
      // Why: Connect is not the Active Server selector anymore, but connected
      // hosts should still contribute their projects/workspaces to the sidebar.
      const repos = await store.fetchRuntimeEnvironmentRepos(environment.id)
      await Promise.all(repos.map((repo) => useAppStore.getState().fetchWorktrees(repo.id)))
      await useAppStore.getState().fetchWorktreeLineage()
      if (mountedRef.current) {
        toast.success(
          translate(
            'auto.components.settings.RuntimeEnvironmentsPane.runtimeReachable',
            '{{value0}} is reachable.',
            { value0: environment.name }
          )
        )
      }
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to connect server.'
      useAppStore.getState().setRuntimeEnvironmentStatus(environment.id, {
        status: null,
        checkedAt: Date.now()
      })
      if (mountedRef.current) {
        setDetailsByEnvironmentId((current) => ({
          ...current,
          [environment.id]: {
            status: 'error',
            runtimeStatus: null,
            compatibility: null,
            error: message
          }
        }))
        setSwitchError(message)
        toast.error(message)
      }
      return false
    } finally {
      if (mountedRef.current) {
        setConnectingId(null)
      }
    }
  }

  const switchToValue = async (value: string): Promise<boolean> => {
    if (value === NO_RUNTIME_VALUE) {
      return false
    }
    setSwitchingValue(value)
    setSwitchError(null)
    try {
      const switched = await switchRuntimeEnvironment(
        allowLocalRuntime && value === LOCAL_RUNTIME_VALUE ? null : value
      )
      if (switched) {
        if (mountedRef.current) {
          toast.success(
            translate(
              'auto.components.settings.RuntimeEnvironmentsPane.99ac81fb43',
              'Switched to {{value0}}.',
              { value0: getEnvironmentLabel(value) }
            )
          )
        }
        return true
      }
      if (mountedRef.current) {
        setSwitchError('Could not switch servers. Fix the issue and try again.')
      }
      return false
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to switch servers.'
      if (mountedRef.current) {
        setSwitchError(message)
        toast.error(message)
      }
      return false
    } finally {
      if (mountedRef.current) {
        setSwitchingValue(null)
      }
    }
  }

  const getEnvironmentLabel = (value: string): string => {
    if (value === LOCAL_RUNTIME_VALUE) {
      return 'Local desktop'
    }
    if (value === NO_RUNTIME_VALUE) {
      return 'No server connected'
    }
    return environments.find((environment) => environment.id === value)?.name ?? 'remote server'
  }

  return (
    <SearchableSetting
      title={searchEntry.title}
      description={searchEntry.description}
      keywords={searchEntry.keywords}
      className="space-y-4 py-2"
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium">
              {translate(
                'auto.components.settings.RuntimeEnvironmentsPane.connectToRemoteServers',
                'Connect to remote servers'
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.RuntimeEnvironmentsPane.connectToRemoteServersHelp',
                'Pair another Orca runtime, then connect or disconnect it here. Use Advanced > Active Server only when you want to change the default host.'
              )}
            </p>
          </div>
          {addServerFormOpen ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setAddServerFormOpen(true)}
              disabled={isBusy}
            >
              <Plus />
              {translate(
                'auto.components.settings.RuntimeEnvironmentsPane.9bee6bbeeb',
                'Add Server'
              )}
            </Button>
          )}
        </div>

        {addServerFormOpen ? (
          <form
            className="space-y-3 rounded-lg border border-border/50 bg-muted/20 p-3"
            onSubmit={(event) => {
              event.preventDefault()
              void addEnvironment()
            }}
          >
            <div className="grid gap-3 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)]">
              <div className="space-y-1">
                <Label htmlFor="runtime-server-name">
                  {translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.54ebacc600',
                    'Server name'
                  )}
                </Label>
                <Input
                  id="runtime-server-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.e038625857',
                    'Dev box'
                  )}
                  className="h-8 text-xs"
                  autoFocus
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="runtime-server-pairing-code">
                  {translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.9bc9b83474',
                    'Pairing code'
                  )}
                </Label>
                <Input
                  id="runtime-server-pairing-code"
                  aria-describedby="runtime-server-pairing-code-help"
                  value={pairingCode}
                  onChange={(event) => setPairingCode(event.target.value)}
                  placeholder={translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.c3d772c514',
                    'orca://pair?code=...'
                  )}
                  className="h-8 min-w-0 font-mono text-xs"
                />
                <p id="runtime-server-pairing-code-help" className="text-xs text-muted-foreground">
                  {translate('auto.components.settings.RuntimeEnvironmentsPane.163671f7b5', 'Run')}{' '}
                  <span className="font-mono">
                    {translate(
                      'auto.components.settings.RuntimeEnvironmentsPane.960e901ae4',
                      'orca serve --pairing-address <host>'
                    )}
                  </span>{' '}
                  {translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.55fcc964cd',
                    'on the server and paste the printed pairing URL.'
                  )}
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={closeAddServerForm}
                disabled={isSaving}
              >
                {translate('auto.components.settings.RuntimeEnvironmentsPane.af53761f31', 'Cancel')}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={isBusy || !name.trim() || !pairingCode.trim()}
              >
                {isSaving ? <Loader2 className="animate-spin" /> : <Plus />}
                {translate(
                  'auto.components.settings.RuntimeEnvironmentsPane.9bee6bbeeb',
                  'Add Server'
                )}
              </Button>
            </div>
          </form>
        ) : null}

        <div className="rounded-lg border border-border/50 bg-card/30">
          {environments.length === 0 ? (
            <div className="px-3 py-4 text-sm text-muted-foreground">
              {translate(
                'auto.components.settings.RuntimeEnvironmentsPane.9a3758d983',
                'No saved servers.'
              )}
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {environments.map((environment) => (
                <div
                  key={environment.id}
                  data-settings-section={environment.id}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  {(() => {
                    const details = detailsByEnvironmentId[environment.id]
                    const detailsDescription = getHostDetailsDescription(details)
                    const isActive = settings.activeRuntimeEnvironmentId === environment.id
                    const connectionState = getRuntimeServerConnectionState(details)
                    // A connected host exposes Disconnect; otherwise Connect.
                    const isReachable = connectionState === 'connected'
                    const actionBusy =
                      connectingId === environment.id ||
                      switchingValue === environment.id ||
                      disconnectingId === environment.id ||
                      removingId === environment.id
                    return (
                      <>
                        <Server className="size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <div className="truncate text-sm font-medium">{environment.name}</div>
                            <span
                              className={cn(
                                'size-2 shrink-0 rounded-full',
                                getRuntimeServerDotClass(connectionState)
                              )}
                            />
                            <span className="text-[11px] text-muted-foreground">
                              {getRuntimeServerConnectionLabel(connectionState)}
                            </span>
                            {details?.compatibility?.kind === 'blocked' ? (
                              <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
                            ) : details?.status === 'loading' ? (
                              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                            ) : null}
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            {isActive
                              ? translate(
                                  'auto.components.settings.RuntimeEnvironmentsPane.activeServerRowHelp',
                                  'Active server for server-routed projects, terminals, and provider checks.'
                                )
                              : getHostDetailsSummary(details)}
                          </p>
                          {detailsDescription ? (
                            <p
                              className={cn(
                                'mt-0.5 truncate text-xs',
                                details?.compatibility?.kind === 'blocked'
                                  ? 'text-destructive'
                                  : 'text-muted-foreground'
                              )}
                            >
                              {detailsDescription}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {isReachable ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              className="gap-1.5"
                              onClick={() => void disconnectEnvironment(environment)}
                              disabled={actionBusy}
                            >
                              {disconnectingId === environment.id ? (
                                <Loader2 className="size-3 animate-spin" />
                              ) : (
                                <ServerOff className="size-3" />
                              )}
                              {translate(
                                'auto.components.settings.RuntimeEnvironmentsPane.disconnect',
                                'Disconnect'
                              )}
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              className="gap-1.5"
                              onClick={() => void connectEnvironment(environment)}
                              disabled={actionBusy || connectionState === 'checking'}
                            >
                              {connectingId === environment.id ? (
                                <Loader2 className="size-3 animate-spin" />
                              ) : (
                                <Server className="size-3" />
                              )}
                              {translate(
                                'auto.components.settings.RuntimeEnvironmentsPane.connect',
                                'Connect'
                              )}
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              setRemoveError(null)
                              setPendingRemove(environment)
                            }}
                            className="size-7 text-muted-foreground hover:text-red-400"
                            disabled={isBusy}
                            aria-label={translate(
                              'auto.components.settings.RuntimeEnvironmentsPane.aeb26635d2',
                              'Remove {{value0}}',
                              { value0: environment.name }
                            )}
                          >
                            {removingId === environment.id ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <Trash2 className="size-3" />
                            )}
                          </Button>
                        </div>
                      </>
                    )
                  })()}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <EphemeralVmRuntimesSection />

      <div data-settings-section="default-runtime">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setAdvancedOpen((current) => !current)}
          className="-ml-2 text-xs"
        >
          {translate('auto.components.settings.RuntimeEnvironmentsPane.advanced', 'Advanced')}
          <ChevronDown
            className={cn('size-4 transition-transform', advancedOpen && 'rotate-180')}
          />
        </Button>

        <div
          className={cn(
            'grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out',
            advancedOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
          )}
          aria-hidden={!advancedOpen}
        >
          <div className="min-h-0">
            <div
              className={cn(
                'space-y-2 px-1 pt-3 pb-1 transition-[opacity,transform] duration-150 ease-out',
                advancedOpen
                  ? 'translate-y-0 opacity-100 delay-200'
                  : '-translate-y-1 opacity-0 delay-0'
              )}
            >
              <div className="space-y-1">
                <Label id="runtime-active-server-label">
                  {translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.64b6bea541',
                    'Default runtime'
                  )}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {getActiveServerModeDescription(allowLocalRuntime)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={activeValue}
                  onValueChange={(value) => {
                    if (value !== activeValue) {
                      setSwitchError(null)
                      setPendingSwitchValue(value)
                    }
                  }}
                  disabled={isBusy}
                >
                  <SelectTrigger
                    size="sm"
                    className="min-w-[260px]"
                    aria-labelledby="runtime-active-server-label"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {allowLocalRuntime ? (
                      <SelectItem value={LOCAL_RUNTIME_VALUE}>
                        {translate(
                          'auto.components.settings.RuntimeEnvironmentsPane.78692becbd',
                          'Local desktop'
                        )}
                      </SelectItem>
                    ) : environments.length === 0 ? (
                      <SelectItem value={NO_RUNTIME_VALUE} disabled>
                        {translate(
                          'auto.components.settings.RuntimeEnvironmentsPane.b07070ed3c',
                          'No server connected'
                        )}
                      </SelectItem>
                    ) : null}
                    {environments.map((environment) => (
                      <SelectItem key={environment.id} value={environment.id}>
                        {environment.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.6ce4664003',
                    'Refresh servers'
                  )}
                  title={translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.6ce4664003',
                    'Refresh servers'
                  )}
                  onClick={() => void loadEnvironments()}
                  disabled={isLoading || isBusy}
                >
                  {isLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                </Button>
              </div>
              {environments.length > 0 ? (
                <div className="space-y-2 pt-2">
                  <div className="text-xs font-medium">
                    {translate(
                      'auto.components.settings.RuntimeEnvironmentsPane.serverDetails',
                      'Server details'
                    )}
                  </div>
                  <div className="space-y-1 rounded-lg border border-border/50 bg-card/30 p-2">
                    {environments.map((environment) => {
                      const details = detailsByEnvironmentId[environment.id]
                      return (
                        <div
                          key={environment.id}
                          className="grid gap-1 rounded-md px-2 py-1.5 text-[11px] text-muted-foreground sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)]"
                        >
                          <div className="truncate font-medium text-foreground">
                            {environment.name}
                          </div>
                          <div className="min-w-0 space-y-0.5">
                            <div className="truncate font-mono">
                              {environment.endpoints[0]?.endpoint ??
                                translate(
                                  'auto.components.settings.RuntimeEnvironmentsPane.6ef71985da',
                                  'No endpoint'
                                )}
                            </div>
                            {details?.runtimeStatus ? (
                              <div className="truncate">
                                {translate(
                                  'auto.components.settings.RuntimeEnvironmentsPane.0ef838094a',
                                  'Protocol {{value0}}',
                                  {
                                    value0:
                                      details.runtimeStatus?.runtimeProtocolVersion ??
                                      details.runtimeStatus?.protocolVersion ??
                                      0
                                  }
                                )}
                                {details.runtimeStatus.hostPlatform
                                  ? ` · ${details.runtimeStatus.hostPlatform}`
                                  : ''}
                                {' · '}
                                {getRuntimeCapabilitiesSummary(details.runtimeStatus)}
                              </div>
                            ) : null}
                            {getHostModelCapabilitySummary(details?.runtimeStatus) ? (
                              <div className="truncate">
                                {getHostModelCapabilitySummary(details?.runtimeStatus)}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {canGeneratePairingUrl ? (
        <div className="space-y-3 pt-2">
          <div className="space-y-0.5">
            <div className="text-sm font-medium">
              {translate(
                'auto.components.settings.RuntimeEnvironmentsPane.advertiseThisApp',
                'Advertise this app as a server'
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.RuntimeEnvironmentsPane.advertiseThisAppHelp',
                'Create access links for browsers, mobile clients, or another Orca client to connect back to this running app.'
              )}
            </p>
          </div>
          <div className="overflow-hidden rounded-lg border border-border/50 bg-card/30">
            <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0 space-y-0.5">
                <div className="text-sm font-medium">
                  {translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.6e1280ca55',
                    'Share this Orca server'
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.84b9b2be05',
                    'Create a revocable access grant so a browser or another Orca client can connect.'
                  )}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setShareServerFormOpen((open) => !open)}
              >
                <Share2 />
                {shareServerFormOpen
                  ? translate(
                      'auto.components.settings.RuntimeEnvironmentsPane.54dee18f5c',
                      'Hide Form'
                    )
                  : translate(
                      'auto.components.settings.RuntimeEnvironmentsPane.3595fd1948',
                      'New Link'
                    )}
              </Button>
            </div>
            <div className="border-t border-border/40 px-3 py-3">
              <RuntimePairingUrlGenerator
                framed={false}
                showHeader={false}
                showGeneratorForm={shareServerFormOpen}
              />
            </div>
          </div>
        </div>
      ) : null}

      <Dialog
        open={pendingSwitchValue !== null}
        onOpenChange={(open) => {
          if (!open && switchingValue === null) {
            setSwitchError(null)
            setPendingSwitchValue(null)
          }
        }}
      >
        <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">
              {translate(
                'auto.components.settings.RuntimeEnvironmentsPane.d570c35a99',
                'Switch Server'
              )}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.settings.RuntimeEnvironmentsPane.b2290ed203',
                'Orca will focus this host and load its projects. Existing terminals and browser tabs on other hosts stay alive.'
              )}
            </DialogDescription>
          </DialogHeader>
          {pendingSwitchValue ? (
            <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
              <div className="text-muted-foreground">
                {translate(
                  'auto.components.settings.RuntimeEnvironmentsPane.05e0fc3ebf',
                  'Switch to'
                )}
              </div>
              <div className="mt-0.5 truncate font-medium">
                {getEnvironmentLabel(pendingSwitchValue)}
              </div>
            </div>
          ) : null}
          {switchError ? <p className="text-sm text-destructive">{switchError}</p> : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setSwitchError(null)
                setPendingSwitchValue(null)
              }}
              disabled={switchingValue !== null}
            >
              {translate('auto.components.settings.RuntimeEnvironmentsPane.af53761f31', 'Cancel')}
            </Button>
            <Button
              onClick={() => {
                const value = pendingSwitchValue
                if (!value) {
                  return
                }
                void switchToValue(value).then((switched) => {
                  if (switched && mountedRef.current) {
                    setPendingSwitchValue(null)
                  }
                })
              }}
              disabled={switchingValue !== null}
            >
              {switchingValue !== null ? <Loader2 className="animate-spin" /> : null}
              {translate('auto.components.settings.RuntimeEnvironmentsPane.d2e00809e4', 'Switch')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open && removingId === null) {
            setRemoveError(null)
            setPendingRemove(null)
          }
        }}
      >
        <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">
              {translate(
                'auto.components.settings.RuntimeEnvironmentsPane.bb90dd6487',
                'Remove Server'
              )}
            </DialogTitle>
            <DialogDescription>
              {removingActiveServer
                ? allowLocalRuntime
                  ? translate(
                      'auto.components.settings.RuntimeEnvironmentsPane.9f7665a01b',
                      'Removing the active server first switches Orca back to Local desktop. Existing host sessions are left alone.'
                    )
                  : translate(
                      'auto.components.settings.RuntimeEnvironmentsPane.b2fda48c39',
                      'Removing the active server disconnects this browser from that host. Existing host sessions are left alone.'
                    )
                : translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.ed3e3f069d',
                    'This removes the saved server from Orca. It does not change the active server.'
                  )}
            </DialogDescription>
          </DialogHeader>
          {pendingRemove ? (
            <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
              <div className="truncate font-medium">{pendingRemove.name}</div>
              <div className="mt-0.5 truncate font-mono text-muted-foreground">
                {pendingRemove.endpoints[0]?.endpoint ??
                  translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.6ef71985da',
                    'No endpoint'
                  )}
              </div>
            </div>
          ) : null}
          {removeError ? <p className="text-sm text-destructive">{removeError}</p> : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRemoveError(null)
                setPendingRemove(null)
              }}
              disabled={removingId !== null}
            >
              {translate('auto.components.settings.RuntimeEnvironmentsPane.af53761f31', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const environment = pendingRemove
                if (!environment) {
                  return
                }
                void removeEnvironment(environment).then((removed) => {
                  if (removed && mountedRef.current) {
                    setPendingRemove(null)
                  }
                })
              }}
              disabled={removingId !== null}
            >
              {removingId !== null ? <Loader2 className="animate-spin" /> : <Trash2 />}
              {translate('auto.components.settings.RuntimeEnvironmentsPane.d25f0688b1', 'Remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SearchableSetting>
  )
}

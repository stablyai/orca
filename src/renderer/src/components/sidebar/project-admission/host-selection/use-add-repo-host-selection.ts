import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '@/store/index'
import { toast } from 'sonner'
import {
  getSettingsFocusedExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { SshConnectionState } from '../../../../../../shared/ssh-types'
import { isEphemeralVmRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { AddRepoDialogStep } from '../dialog/add-repo-dialog-types'
import { useSidebarHostScopeOptions } from '../../worktree-list/controls/use-sidebar-host-scope-options'
import { canConnectAddRepoHost, canSelectAddRepoHost } from './add-repo-host-availability'
import {
  indexExecutionHostsById,
  pickerExecutionHosts
} from '../../../../../../shared/execution-host/managed-orcad-execution-host'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/runtime/errors/ipc-error'
import { toastSshConnectFailure } from '@/ssh/ssh-connect-failure-toast'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'

export function useAddRepoHostSelection({
  isOpen,
  setStep,
  preferredHostId = null,
  defaultHostId = null,
  openKey
}: {
  isOpen: boolean
  setStep: (step: AddRepoDialogStep) => void
  /** The host the dialog was opened for (a dropped folder's owner or explicit menu choice); wins over all defaults. */
  preferredHostId?: ExecutionHostId | null
  /** Contextual default host (e.g. the composer's Run on host); wins over the focused host when selectable. */
  defaultHostId?: ExecutionHostId | null
  /** Distinguishes back-to-back entry requests while open. */
  openKey?: number | string | null
}): {
  hostOptions: ReturnType<typeof useSidebarHostScopeOptions>['hostOptions']
  selectedHostId: ExecutionHostId | null
  /** The host the picker shows: the chosen one, even while it is still coming up. */
  displayedHostId: ExecutionHostId | null
  selectedParsedHost: ReturnType<typeof parseExecutionHostId>
  selectedHostLabel: string | null
  hostSelectorOpen: boolean
  setHostSelectorOpen: (open: boolean) => void
  /** False when the host cannot be selected, so the selection did not change. */
  handleSelectAddProjectHost: (hostId: ExecutionHostId) => Promise<boolean>
  /** False when the host did not connect (the failure is already toasted). */
  handleConnectAddProjectHost: (hostId: ExecutionHostId) => Promise<boolean>
} {
  const settings = useAppStore((s) => s.settings)
  const setSshConnectionState = useAppStore((s) => s.setSshConnectionState)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const { hostOptions } = useSidebarHostScopeOptions()
  const isWebClient = isWebClientLocation()
  const ephemeralRuntimeEnvironmentIds = useMemo(
    () =>
      new Set(
        runtimeEnvironments
          .filter(isEphemeralVmRuntimeEnvironment)
          .map((environment) => environment.id)
      ),
    [runtimeEnvironments]
  )
  const selectableHostOptions = useMemo(
    () =>
      pickerExecutionHosts(hostOptions).filter((host) => {
        const parsed = parseExecutionHostId(host.id)
        return (
          !(isWebClient && parsed?.kind === 'local') &&
          (parsed?.kind !== 'runtime' || !ephemeralRuntimeEnvironmentIds.has(parsed.environmentId))
        )
      }),
    [ephemeralRuntimeEnvironmentIds, hostOptions, isWebClient]
  )
  const pairedWebRuntimeHost = isWebClient
    ? selectableHostOptions.find((host) => host.kind === 'runtime' && canSelectAddRepoHost(host))
    : undefined
  const hostsById = useMemo(() => indexExecutionHostsById(hostOptions), [hostOptions])
  const preferredHost = preferredHostId ? hostsById.get(preferredHostId) : undefined
  const defaultHost = defaultHostId ? hostsById.get(defaultHostId) : undefined
  const focusedHost = isOpen
    ? hostsById.get(getSettingsFocusedExecutionHostId(settings))
    : undefined
  // A dropped folder's WSL host may still be starting; do not require canSelectAddRepoHost yet.
  const openTargetHostId =
    preferredHost && selectableHostOptions.includes(preferredHost)
      ? preferredHost.id
      : defaultHost &&
          selectableHostOptions.includes(defaultHost) &&
          (canSelectAddRepoHost(defaultHost) ||
            canConnectAddRepoHost(defaultHost) ||
            defaultHost.kind === 'ssh')
        ? defaultHost.id
        : focusedHost &&
            selectableHostOptions.includes(focusedHost) &&
            canSelectAddRepoHost(focusedHost)
          ? focusedHost.id
          : (pairedWebRuntimeHost?.id ?? (isWebClient ? null : LOCAL_EXECUTION_HOST_ID))
  const activeOpenToken = isOpen ? (openKey ?? 'open') : null
  const [lastOpenToken, setLastOpenToken] = useState<number | string | null>(activeOpenToken)
  const [selectedAddProjectHostId, setSelectedAddProjectHostId] = useState<ExecutionHostId>(
    (isOpen ? openTargetHostId : null) ?? LOCAL_EXECUTION_HOST_ID
  )
  const [hostSelectorOpen, setHostSelectorOpen] = useState(false)
  if (lastOpenToken !== activeOpenToken) {
    setLastOpenToken(activeOpenToken)
    if (isOpen) {
      if (openTargetHostId) {
        setSelectedAddProjectHostId(openTargetHostId)
      }
    } else {
      setHostSelectorOpen(false)
    }
  }

  // Why through the index: a connect saves the SSH id, which may now stand under its server's row.
  const resolvedHost = hostsById.get(selectedAddProjectHostId)
  const requestedHost =
    resolvedHost && selectableHostOptions.includes(resolvedHost) ? resolvedHost : undefined
  const requestedHostSelectable = requestedHost ? canSelectAddRepoHost(requestedHost) : false
  // A connecting, unavailable remote, or unmerged SSH target must block actions rather than silently select this computer.
  const requestedHostPending =
    requestedHost !== undefined &&
    !requestedHostSelectable &&
    (requestedHost.id !== LOCAL_EXECUTION_HOST_ID || (requestedHost.aliasHostIds?.length ?? 0) > 0)
  const selectedHost = requestedHostSelectable
    ? requestedHost
    : requestedHostPending
      ? undefined
      : (pairedWebRuntimeHost ??
        selectableHostOptions.find(
          (host) => host.id === LOCAL_EXECUTION_HOST_ID && canSelectAddRepoHost(host)
        ) ??
        selectableHostOptions.find((host) => canSelectAddRepoHost(host)))
  const selectedHostId =
    selectedHost?.id ?? (isWebClient || requestedHostPending ? null : LOCAL_EXECUTION_HOST_ID)
  const displayedHostId = requestedHostPending ? (requestedHost?.id ?? null) : selectedHostId
  const selectedParsedHost = parseExecutionHostId(selectedHostId)

  const handleSelectAddProjectHost = useCallback(
    async (hostId: ExecutionHostId): Promise<boolean> => {
      const host = selectableHostOptions.find((candidate) => candidate.id === hostId)
      if (!host || !canSelectAddRepoHost(host)) {
        return false
      }
      setSelectedAddProjectHostId(hostId)
      setStep('add')
      return true
    },
    [selectableHostOptions, setSelectedAddProjectHostId, setStep]
  )

  const handleConnectAddProjectHost = useCallback(
    async (hostId: ExecutionHostId): Promise<boolean> => {
      const host = selectableHostOptions.find((candidate) => candidate.id === hostId)
      const parsed = parseExecutionHostId(hostId)
      if (host?.wslDistro !== undefined && parsed?.kind === 'runtime') {
        // Main publishes the WSL host's progress; the row turns selectable once its server answers.
        try {
          await window.api.runtimeEnvironments.connect({ selector: parsed.environmentId })
          setSelectedAddProjectHostId(hostId)
          return true
        } catch (err) {
          toast.error(
            err instanceof Error
              ? err.message
              : translate(
                  'auto.components.sidebar.useAddRepoHostSelection.wslConnectionFailed',
                  'Couldn’t start the WSL host.'
                )
          )
          return false
        }
      }
      if (!host || parsed?.kind !== 'ssh') {
        return false
      }

      const previousState = sshConnectionStates.get(parsed.targetId)
      // Optimistically mark connecting because the global SSH state event may arrive after connect returns.
      setSshConnectionState(parsed.targetId, {
        targetId: parsed.targetId,
        status: 'connecting',
        error: null,
        reconnectAttempt: previousState?.reconnectAttempt ?? 0,
        remotePlatform: previousState?.remotePlatform
      })

      try {
        const connectResult = (await window.api.ssh.connect({
          targetId: parsed.targetId
        })) as SshConnectionState | null | undefined
        const state =
          connectResult ??
          ((await window.api.ssh.getState({
            targetId: parsed.targetId
          })) as SshConnectionState | null)
        if (state) {
          setSshConnectionState(parsed.targetId, state)
        }
        if (state?.status !== 'connected') {
          return false
        }
        setSelectedAddProjectHostId(hostId)
        setStep('add')
        setHostSelectorOpen(false)
        return true
      } catch (err) {
        const fallback = translate(
          'auto.components.sidebar.useAddRepoHostSelection.connectionFailed',
          'SSH connection failed.'
        )
        // Main publishes the failure and its reason; only replace our own optimistic row.
        if (
          useAppStore.getState().sshConnectionStates.get(parsed.targetId)?.status === 'connecting'
        ) {
          setSshConnectionState(parsed.targetId, {
            targetId: parsed.targetId,
            status: 'error',
            error: extractIpcErrorMessage(err, fallback),
            reconnectAttempt: previousState?.reconnectAttempt ?? 0,
            remotePlatform: previousState?.remotePlatform
          })
        }
        toastSshConnectFailure(parsed.targetId, err, fallback)
        return false
      }
    },
    [
      selectableHostOptions,
      setHostSelectorOpen,
      setSelectedAddProjectHostId,
      setSshConnectionState,
      setStep,
      sshConnectionStates
    ]
  )

  return {
    hostOptions: selectableHostOptions,
    selectedHostId,
    displayedHostId,
    selectedParsedHost,
    selectedHostLabel:
      selectableHostOptions.find((host) => host.id === selectedHostId)?.label ?? null,
    hostSelectorOpen,
    setHostSelectorOpen,
    handleSelectAddProjectHost,
    handleConnectAddProjectHost
  }
}

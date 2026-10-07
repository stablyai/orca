import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { toast } from 'sonner'
import {
  getSettingsFocusedExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import { isEphemeralVmRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import { useSidebarHostScopeOptions } from './use-sidebar-host-scope-options'
import { canSelectAddRepoHost } from './add-repo-host-availability'
import {
  indexExecutionHostsById,
  pickerExecutionHosts
} from '../../../../shared/managed-orcad-execution-host'
import { translate } from '@/i18n/i18n'
import { isWebClientLocation } from '@/lib/web-client-location'

export function useAddRepoHostSelection({
  isOpen,
  setStep
}: {
  isOpen: boolean
  setStep: (step: AddRepoDialogStep) => void
}): {
  hostOptions: ReturnType<typeof useSidebarHostScopeOptions>['hostOptions']
  selectedHostId: ExecutionHostId | null
  /** The host the picker shows: the chosen one, even while it is still coming up. */
  displayedHostId: ExecutionHostId | null
  selectedParsedHost: ReturnType<typeof parseExecutionHostId>
  selectedSshTargetId: string | null
  hostSelectorOpen: boolean
  setHostSelectorOpen: (open: boolean) => void
  handleSelectAddProjectHost: (hostId: ExecutionHostId) => Promise<void>
  handleConnectAddProjectHost: (hostId: ExecutionHostId) => Promise<void>
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
  const [selectedAddProjectHostId, setSelectedAddProjectHostId] =
    useState<ExecutionHostId>(LOCAL_EXECUTION_HOST_ID)
  const [hostSelectorOpen, setHostSelectorOpen] = useState(false)
  const previousOpenRef = useRef(false)
  const pairedWebRuntimeHost = isWebClient
    ? selectableHostOptions.find((host) => host.kind === 'runtime' && canSelectAddRepoHost(host))
    : undefined

  // Why through the index: a connect saves the SSH id, which may now stand under its server's row.
  const resolvedHost = indexExecutionHostsById(hostOptions).get(selectedAddProjectHostId)
  const requestedHost =
    resolvedHost && selectableHostOptions.includes(resolvedHost) ? resolvedHost : undefined
  const requestedHostSelectable = requestedHost ? canSelectAddRepoHost(requestedHost) : false
  // Why: a merged SSH host is still coming up on its server right after its connect; that blocks
  // the actions rather than silently turning into this computer.
  const requestedHostPending =
    requestedHost !== undefined &&
    !requestedHostSelectable &&
    (requestedHost.aliasHostIds?.length ?? 0) > 0
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
  const selectedSshTargetId =
    selectedParsedHost?.kind === 'ssh' ? selectedParsedHost.targetId : null

  useEffect(() => {
    if (isOpen && !previousOpenRef.current) {
      const focusedHost = indexExecutionHostsById(hostOptions).get(
        getSettingsFocusedExecutionHostId(settings)
      )
      const nextHostId =
        focusedHost &&
        selectableHostOptions.includes(focusedHost) &&
        canSelectAddRepoHost(focusedHost)
          ? focusedHost.id
          : (pairedWebRuntimeHost?.id ?? (isWebClient ? null : LOCAL_EXECUTION_HOST_ID))
      if (nextHostId) {
        setSelectedAddProjectHostId(nextHostId)
      }
    }
    if (!isOpen) {
      setHostSelectorOpen(false)
    }
    previousOpenRef.current = isOpen
  }, [hostOptions, isOpen, isWebClient, pairedWebRuntimeHost?.id, selectableHostOptions, settings])

  const handleSelectAddProjectHost = useCallback(
    async (hostId: ExecutionHostId): Promise<void> => {
      const host = selectableHostOptions.find((candidate) => candidate.id === hostId)
      if (!host || !canSelectAddRepoHost(host)) {
        return
      }
      setSelectedAddProjectHostId(hostId)
      setStep('add')
    },
    [selectableHostOptions, setStep]
  )

  const handleConnectAddProjectHost = useCallback(
    async (hostId: ExecutionHostId): Promise<void> => {
      const host = selectableHostOptions.find((candidate) => candidate.id === hostId)
      const parsed = parseExecutionHostId(hostId)
      if (!host || parsed?.kind !== 'ssh') {
        return
      }

      const previousState = sshConnectionStates.get(parsed.targetId)
      // Why: ssh.connect can complete before the global state-change event
      // reaches the renderer; optimistic state keeps this picker responsive.
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
          return
        }
        setSelectedAddProjectHostId(hostId)
        setStep('add')
        setHostSelectorOpen(false)
      } catch (err) {
        setSshConnectionState(
          parsed.targetId,
          previousState ?? {
            targetId: parsed.targetId,
            status: 'disconnected',
            error:
              err instanceof Error
                ? err.message
                : translate(
                    'auto.components.sidebar.useAddRepoHostSelection.connectionFailed',
                    'SSH connection failed.'
                  ),
            reconnectAttempt: 0
          }
        )
        toast.error(
          err instanceof Error
            ? err.message
            : translate(
                'auto.components.sidebar.useAddRepoHostSelection.connectionFailed',
                'SSH connection failed.'
              )
        )
      }
    },
    [selectableHostOptions, setSshConnectionState, setStep, sshConnectionStates]
  )

  return {
    hostOptions: selectableHostOptions,
    selectedHostId,
    displayedHostId,
    selectedParsedHost,
    selectedSshTargetId,
    hostSelectorOpen,
    setHostSelectorOpen,
    handleSelectAddProjectHost,
    handleConnectAddProjectHost
  }
}

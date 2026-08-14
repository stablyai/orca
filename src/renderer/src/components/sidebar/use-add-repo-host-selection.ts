import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { toast } from 'sonner'
import {
  getSettingsFocusedExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import { isEphemeralVmRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import { useSidebarHostScopeOptions } from './use-sidebar-host-scope-options'
import { canSelectAddRepoHost } from './add-repo-host-availability'
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
  displayedHostId: ExecutionHostId | null
  actionableHostId: ExecutionHostId | null
  actionableParsedHost: ReturnType<typeof parseExecutionHostId>
  hostSelectionAvailable: boolean
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
  const pairedWebRuntimeHostId =
    isWebClient && runtimeEnvironments.length === 1
      ? toRuntimeExecutionHostId(runtimeEnvironments[0]!.id)
      : null
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
      hostOptions.filter((host) => {
        const parsed = parseExecutionHostId(host.id)
        return (
          (!isWebClient || host.id === pairedWebRuntimeHostId) &&
          (parsed?.kind !== 'runtime' || !ephemeralRuntimeEnvironmentIds.has(parsed.environmentId))
        )
      }),
    [ephemeralRuntimeEnvironmentIds, hostOptions, isWebClient, pairedWebRuntimeHostId]
  )
  const [selectedAddProjectHostId, setSelectedAddProjectHostId] =
    useState<ExecutionHostId>(LOCAL_EXECUTION_HOST_ID)
  const [hostSelectorOpen, setHostSelectorOpen] = useState(false)
  const previousOpenRef = useRef(false)
  const pairedWebRuntimeHost = pairedWebRuntimeHostId
    ? selectableHostOptions.find((host) => host.id === pairedWebRuntimeHostId)
    : undefined

  const selectedHost = selectableHostOptions.find((host) => host.id === selectedAddProjectHostId)
  const pairedWebRuntimeActionable = Boolean(
    pairedWebRuntimeHost && canSelectAddRepoHost(pairedWebRuntimeHost)
  )
  const validPairedWebSelection =
    selectedHost?.kind !== 'runtime' || selectedHost.id === pairedWebRuntimeHostId
      ? selectedHost
      : undefined
  const hostSelectionAvailable = !isWebClient || pairedWebRuntimeActionable
  const displayedHost = isWebClient
    ? pairedWebRuntimeActionable
      ? (validPairedWebSelection ?? pairedWebRuntimeHost)
      : pairedWebRuntimeHost
    : selectedHost && canSelectAddRepoHost(selectedHost)
      ? selectedHost
      : (selectableHostOptions.find(
          (host) => host.id === LOCAL_EXECUTION_HOST_ID && canSelectAddRepoHost(host)
        ) ?? selectableHostOptions.find((host) => canSelectAddRepoHost(host)))
  const displayedHostId = displayedHost?.id ?? (isWebClient ? null : LOCAL_EXECUTION_HOST_ID)
  const actionableHostId =
    displayedHost && hostSelectionAvailable && canSelectAddRepoHost(displayedHost)
      ? displayedHost.id
      : null
  const actionableParsedHost = parseExecutionHostId(actionableHostId)
  const selectedSshTargetId =
    actionableParsedHost?.kind === 'ssh' ? actionableParsedHost.targetId : null

  useEffect(() => {
    if (isOpen && !previousOpenRef.current) {
      const focusedHostId = getSettingsFocusedExecutionHostId(settings)
      const nextHostId = selectableHostOptions.some(
        (host) => host.id === focusedHostId && canSelectAddRepoHost(host)
      )
        ? focusedHostId
        : (pairedWebRuntimeHost?.id ?? (isWebClient ? null : LOCAL_EXECUTION_HOST_ID))
      if (nextHostId) {
        setSelectedAddProjectHostId(nextHostId)
      }
    }
    if (!isOpen) {
      setHostSelectorOpen(false)
    }
    previousOpenRef.current = isOpen
  }, [isOpen, isWebClient, pairedWebRuntimeHost?.id, selectableHostOptions, settings])

  const handleSelectAddProjectHost = useCallback(
    async (hostId: ExecutionHostId): Promise<void> => {
      const host = selectableHostOptions.find((candidate) => candidate.id === hostId)
      if (!hostSelectionAvailable || !host || !canSelectAddRepoHost(host)) {
        return
      }
      setSelectedAddProjectHostId(hostId)
      setStep('add')
    },
    [hostSelectionAvailable, selectableHostOptions, setStep]
  )

  const handleConnectAddProjectHost = useCallback(
    async (hostId: ExecutionHostId): Promise<void> => {
      const host = selectableHostOptions.find((candidate) => candidate.id === hostId)
      const parsed = parseExecutionHostId(hostId)
      if (!hostSelectionAvailable || !host || parsed?.kind !== 'ssh') {
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
    [
      hostSelectionAvailable,
      selectableHostOptions,
      setSshConnectionState,
      setStep,
      sshConnectionStates
    ]
  )

  return {
    hostOptions: selectableHostOptions,
    displayedHostId,
    actionableHostId,
    actionableParsedHost,
    hostSelectionAvailable,
    selectedSshTargetId,
    hostSelectorOpen,
    setHostSelectorOpen,
    handleSelectAddProjectHost,
    handleConnectAddProjectHost
  }
}

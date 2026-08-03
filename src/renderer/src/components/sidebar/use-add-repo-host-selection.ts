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
import { translate } from '@/i18n/i18n'

export function useAddRepoHostSelection({
  isOpen,
  setStep
}: {
  isOpen: boolean
  setStep: (step: AddRepoDialogStep) => void
}): {
  hostOptions: ReturnType<typeof useSidebarHostScopeOptions>['hostOptions']
  selectedHostId: ExecutionHostId
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
          parsed?.kind !== 'runtime' || !ephemeralRuntimeEnvironmentIds.has(parsed.environmentId)
        )
      }),
    [ephemeralRuntimeEnvironmentIds, hostOptions]
  )
  const [selectedAddProjectHostId, setSelectedAddProjectHostId] =
    useState<ExecutionHostId>(LOCAL_EXECUTION_HOST_ID)
  const [hostSelectorOpen, setHostSelectorOpen] = useState(false)
  const previousOpenRef = useRef(false)

  const selectedHost =
    selectableHostOptions.find(
      (host) => host.id === selectedAddProjectHostId && canSelectAddRepoHost(host)
    ) ??
    selectableHostOptions.find(
      (host) => host.id === LOCAL_EXECUTION_HOST_ID && canSelectAddRepoHost(host)
    ) ??
    selectableHostOptions.find((host) => canSelectAddRepoHost(host)) ??
    selectableHostOptions[0]
  const selectedHostId = selectedHost?.id ?? LOCAL_EXECUTION_HOST_ID
  const selectedParsedHost = parseExecutionHostId(selectedHostId)
  const selectedSshTargetId =
    selectedParsedHost?.kind === 'ssh' ? selectedParsedHost.targetId : null

  useEffect(() => {
    if (isOpen && !previousOpenRef.current) {
      const focusedHostId = getSettingsFocusedExecutionHostId(settings)
      const nextHostId = selectableHostOptions.some(
        (host) => host.id === focusedHostId && canSelectAddRepoHost(host)
      )
        ? focusedHostId
        : LOCAL_EXECUTION_HOST_ID
      setSelectedAddProjectHostId(nextHostId)
    }
    if (!isOpen) {
      setHostSelectorOpen(false)
    }
    previousOpenRef.current = isOpen
  }, [isOpen, selectableHostOptions, settings])

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
    selectedParsedHost,
    selectedSshTargetId,
    hostSelectorOpen,
    setHostSelectorOpen,
    handleSelectAddProjectHost,
    handleConnectAddProjectHost
  }
}

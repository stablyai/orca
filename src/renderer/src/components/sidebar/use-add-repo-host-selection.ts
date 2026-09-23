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
  addProjectHostOptionOrder,
  buildAddProjectWslDistroOptions,
  parseWslDistroOptionId,
  toWslDistroOptionId,
  type AddProjectHostOption
} from './add-project-wsl-host-options'
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
  /** Selector rows: execution hosts plus WSL distro sub-rows of Local Windows. */
  addProjectHostOptions: AddProjectHostOption[]
  /** Dialog-local option key of the selection (`wsl-distro:<distro>` or an ExecutionHostId). */
  selectedOptionId: string | null
  selectedHostId: ExecutionHostId | null
  /** Set when the selection is a WSL distro row; host stays local in that case. */
  selectedWslDistro: string | null
  selectedParsedHost: ReturnType<typeof parseExecutionHostId>
  selectedSshTargetId: string | null
  hostSelectorOpen: boolean
  setHostSelectorOpen: (open: boolean) => void
  handleSelectAddProjectHost: (optionId: string) => Promise<void>
  handleConnectAddProjectHost: (optionId: string) => Promise<void>
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
      hostOptions.filter((host) => {
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
  const [selectedWslDistro, setSelectedWslDistro] = useState<string | null>(null)
  const [wslDistros, setWslDistros] = useState<string[]>([])
  const [runningWslDistros, setRunningWslDistros] = useState<ReadonlySet<string>>(() => new Set())
  const [hostSelectorOpen, setHostSelectorOpen] = useState(false)

  // Why: self-gating — listDistros returns [] off Windows, so the rows (and
  // their wsl.exe probes) never appear where WSL cannot exist. Optional chain:
  // test and web-client hosts may not wire the wsl surface at all.
  useEffect(() => {
    if (!isOpen) {
      return
    }
    let cancelled = false
    void window.api.wsl
      ?.listDistros()
      .then((distros) => {
        if (!cancelled) {
          setWslDistros(distros)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [isOpen])

  // Why: the readiness badge must not re-spawn wsl.exe on every open — refresh
  // only while the selector is popped, so probing stays user-initiated.
  useEffect(() => {
    if (!hostSelectorOpen || wslDistros.length === 0) {
      return
    }
    let cancelled = false
    void window.api.wsl
      ?.listRunningDistros()
      .then((running) => {
        if (!cancelled) {
          setRunningWslDistros(new Set(running))
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [hostSelectorOpen, wslDistros])

  const wslDistroOptions = useMemo(
    () =>
      buildAddProjectWslDistroOptions({ distros: wslDistros, runningDistros: runningWslDistros }),
    [runningWslDistros, wslDistros]
  )
  const addProjectHostOptions = useMemo(
    () =>
      [...selectableHostOptions, ...wslDistroOptions].sort(
        (left, right) => addProjectHostOptionOrder(left) - addProjectHostOptionOrder(right)
      ),
    [selectableHostOptions, wslDistroOptions]
  )
  const selectedOptionId = selectedWslDistro
    ? toWslDistroOptionId(selectedWslDistro)
    : selectedAddProjectHostId
  const previousOpenRef = useRef(false)
  const pairedWebRuntimeHost = isWebClient
    ? selectableHostOptions.find((host) => host.kind === 'runtime' && canSelectAddRepoHost(host))
    : undefined

  const selectedHost =
    selectableHostOptions.find(
      (host) => host.id === selectedAddProjectHostId && canSelectAddRepoHost(host)
    ) ??
    pairedWebRuntimeHost ??
    selectableHostOptions.find(
      (host) => host.id === LOCAL_EXECUTION_HOST_ID && canSelectAddRepoHost(host)
    ) ??
    selectableHostOptions.find((host) => canSelectAddRepoHost(host))
  const selectedHostId = selectedHost?.id ?? (isWebClient ? null : LOCAL_EXECUTION_HOST_ID)
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
        : (pairedWebRuntimeHost?.id ?? (isWebClient ? null : LOCAL_EXECUTION_HOST_ID))
      if (nextHostId) {
        setSelectedAddProjectHostId(nextHostId)
      }
      setSelectedWslDistro(null)
    }
    if (!isOpen) {
      setHostSelectorOpen(false)
    }
    previousOpenRef.current = isOpen
  }, [isOpen, isWebClient, pairedWebRuntimeHost?.id, selectableHostOptions, settings])

  const handleSelectAddProjectHost = useCallback(
    async (optionId: string): Promise<void> => {
      const wslDistro = parseWslDistroOptionId(optionId)
      if (wslDistro) {
        // Why: a WSL distro row is a sub-mode of the Local Windows host — the
        // repo's ExecutionHostId stays local; the distro rides as session state.
        setSelectedAddProjectHostId(LOCAL_EXECUTION_HOST_ID)
        setSelectedWslDistro(wslDistro)
        setStep('add')
        return
      }
      const host = selectableHostOptions.find((candidate) => candidate.id === optionId)
      const parsed = parseExecutionHostId(optionId)
      if (!host || !parsed || !canSelectAddRepoHost(host)) {
        return
      }
      setSelectedAddProjectHostId(parsed.id)
      setSelectedWslDistro(null)
      setStep('add')
    },
    [selectableHostOptions, setStep]
  )

  const handleConnectAddProjectHost = useCallback(
    async (optionId: string): Promise<void> => {
      const host = selectableHostOptions.find((candidate) => candidate.id === optionId)
      const parsed = parseExecutionHostId(optionId)
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
        setSelectedAddProjectHostId(parsed.id)
        setSelectedWslDistro(null)
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
    addProjectHostOptions,
    selectedOptionId,
    selectedHostId,
    selectedWslDistro,
    selectedParsedHost,
    selectedSshTargetId,
    hostSelectorOpen,
    setHostSelectorOpen,
    handleSelectAddProjectHost,
    handleConnectAddProjectHost
  }
}

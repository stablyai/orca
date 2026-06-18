import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import {
  getSettingsFocusedExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import { useSidebarHostScopeOptions } from './use-sidebar-host-scope-options'
import { canSelectAddRepoHost } from './add-repo-host-availability'

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
} {
  const settings = useAppStore((s) => s.settings)
  const switchRuntimeEnvironment = useAppStore((s) => s.switchRuntimeEnvironment)
  const { hostOptions } = useSidebarHostScopeOptions()
  const [selectedAddProjectHostId, setSelectedAddProjectHostId] =
    useState<ExecutionHostId>(LOCAL_EXECUTION_HOST_ID)
  const [hostSelectorOpen, setHostSelectorOpen] = useState(false)
  const previousOpenRef = useRef(false)

  const selectedHost =
    hostOptions.find(
      (host) => host.id === selectedAddProjectHostId && canSelectAddRepoHost(host)
    ) ??
    hostOptions.find((host) => host.id === LOCAL_EXECUTION_HOST_ID && canSelectAddRepoHost(host)) ??
    hostOptions.find((host) => canSelectAddRepoHost(host)) ??
    hostOptions[0]
  const selectedHostId = selectedHost?.id ?? LOCAL_EXECUTION_HOST_ID
  const selectedParsedHost = parseExecutionHostId(selectedHostId)
  const selectedSshTargetId =
    selectedParsedHost?.kind === 'ssh' ? selectedParsedHost.targetId : null

  useEffect(() => {
    if (isOpen && !previousOpenRef.current) {
      const focusedHostId = getSettingsFocusedExecutionHostId(settings)
      const nextHostId = hostOptions.some(
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
  }, [hostOptions, isOpen, settings])

  const handleSelectAddProjectHost = useCallback(
    async (hostId: ExecutionHostId): Promise<void> => {
      const host = hostOptions.find((candidate) => candidate.id === hostId)
      if (!host || !canSelectAddRepoHost(host)) {
        return
      }
      const parsed = parseExecutionHostId(hostId)
      if (parsed?.kind === 'runtime') {
        const switched = await switchRuntimeEnvironment(parsed.environmentId)
        if (!switched) {
          return
        }
      } else if (settings?.activeRuntimeEnvironmentId?.trim()) {
        const switched = await switchRuntimeEnvironment(null)
        if (!switched) {
          return
        }
      }
      setSelectedAddProjectHostId(hostId)
      setStep('add')
    },
    [hostOptions, settings?.activeRuntimeEnvironmentId, setStep, switchRuntimeEnvironment]
  )

  return {
    hostOptions,
    selectedHostId,
    selectedParsedHost,
    selectedSshTargetId,
    hostSelectorOpen,
    setHostSelectorOpen,
    handleSelectAddProjectHost
  }
}

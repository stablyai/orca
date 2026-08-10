import { useCallback, useEffect, useMemo } from 'react'
import type { GlobalSettings, TerminalQuickCommand } from '../../../shared/types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getHostDisplayLabelOverrides } from '../../../shared/host-setting-overrides'
import { buildExecutionHostRegistry } from '../../../shared/execution-host-registry'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'

export type TerminalQuickCommandHost = {
  commands: readonly TerminalQuickCommand[]
  hostId: ExecutionHostId
  label: string
}

export type TerminalQuickCommandMenuHost = {
  globalCommands: TerminalQuickCommand[]
  hostId: ExecutionHostId
  label: string
  repoCommands: TerminalQuickCommand[]
}

export type HostedTerminalQuickCommand = {
  command: TerminalQuickCommand
  hostId: ExecutionHostId
  hostLabel: string
  key: string
}

export function getHostedTerminalQuickCommandKey(
  hostId: ExecutionHostId,
  commandId: string
): string {
  return `${hostId}\0${commandId}`
}

export function shouldShowTerminalQuickCommandHostOwnership(hosts: readonly unknown[]): boolean {
  return hosts.length > 1
}

export function flattenTerminalQuickCommandHosts(
  hosts: readonly TerminalQuickCommandHost[]
): HostedTerminalQuickCommand[] {
  return hosts.flatMap((host) =>
    host.commands.map((command) => ({
      command,
      hostId: host.hostId,
      hostLabel: host.label,
      key: getHostedTerminalQuickCommandKey(host.hostId, command.id)
    }))
  )
}

export function getTerminalQuickCommandHostOptions(
  settings: GlobalSettings | null | undefined,
  runtimeEnvironments: readonly Pick<PublicKnownRuntimeEnvironment, 'id' | 'name'>[]
): { id: ExecutionHostId; label: string }[] {
  return buildExecutionHostRegistry({
    repos: [],
    settings,
    hostSource: 'configured-only',
    runtimeEnvironments,
    hostLabelOverrides: getHostDisplayLabelOverrides(settings)
  }).map((host) => ({ id: host.id, label: host.label }))
}

export function useTerminalQuickCommandHosts(worktreeId: string): {
  executionHostId: ExecutionHostId
  hosts: TerminalQuickCommandHost[]
  refreshRemoteHost: () => void
  remoteHostLoadFailed: boolean
  remoteHostPending: boolean
} {
  const executionHostId = useAppStore((state) => getExecutionHostIdForWorktree(state, worktreeId))
  const settings = useAppStore((state) => state.settings)
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const remoteState = useAppStore((state) => {
    const parsed = parseExecutionHostId(executionHostId)
    return parsed?.kind === 'runtime'
      ? state.runtimeTerminalQuickCommands.get(parsed.environmentId)
      : undefined
  })
  const loadRemote = useAppStore((state) => state.loadRuntimeTerminalQuickCommands)
  const parsedExecutionHost = parseExecutionHostId(executionHostId)
  const remoteHostId = parsedExecutionHost?.kind === 'runtime' ? parsedExecutionHost.id : null
  const remoteEnvironmentId =
    parsedExecutionHost?.kind === 'runtime' ? parsedExecutionHost.environmentId : null
  const remoteConnectionGeneration = useAppStore((state) =>
    remoteEnvironmentId
      ? (state.runtimeStatusByEnvironmentId.get(remoteEnvironmentId)?.connectionGeneration ?? 0)
      : 0
  )

  useEffect(() => {
    if (remoteEnvironmentId) {
      void loadRemote(remoteEnvironmentId)
    }
  }, [loadRemote, remoteConnectionGeneration, remoteEnvironmentId])

  const refreshRemoteHost = useCallback((): void => {
    if (remoteEnvironmentId) {
      void loadRemote(remoteEnvironmentId, { force: true })
    }
  }, [loadRemote, remoteEnvironmentId])

  const remoteHostPending = Boolean(
    remoteHostId &&
    remoteEnvironmentId &&
    (remoteState?.connectionGeneration !== remoteConnectionGeneration ||
      remoteState.supported === null ||
      remoteState === undefined)
  )
  const remoteHostLoadFailed = Boolean(
    remoteHostPending &&
    remoteState?.connectionGeneration === remoteConnectionGeneration &&
    !remoteState.loading &&
    remoteState.error
  )

  const hosts = useMemo(() => {
    const hostOptions = getTerminalQuickCommandHostOptions(settings, runtimeEnvironments)
    const result: TerminalQuickCommandHost[] = [
      {
        commands: settings?.terminalQuickCommands ?? [],
        hostId: LOCAL_EXECUTION_HOST_ID,
        label:
          hostOptions.find((host) => host.id === LOCAL_EXECUTION_HOST_ID)?.label ?? 'This computer'
      }
    ]
    if (
      !remoteHostId ||
      !remoteEnvironmentId ||
      remoteState?.supported !== true ||
      remoteState.connectionGeneration !== remoteConnectionGeneration
    ) {
      return result
    }
    result.push({
      commands: remoteState.commands,
      hostId: remoteHostId,
      label: hostOptions.find((host) => host.id === remoteHostId)?.label ?? remoteEnvironmentId
    })
    return result
  }, [
    remoteConnectionGeneration,
    remoteEnvironmentId,
    remoteHostId,
    remoteState,
    runtimeEnvironments,
    settings
  ])

  return {
    executionHostId,
    hosts,
    refreshRemoteHost,
    remoteHostLoadFailed,
    remoteHostPending
  }
}

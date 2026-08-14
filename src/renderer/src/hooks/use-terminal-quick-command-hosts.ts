import { useCallback, useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
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
import type {
  RuntimeTerminalQuickCommands,
  TerminalQuickCommandHostsSlice
} from '@/store/slices/terminal-quick-command-hosts'
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

type TerminalQuickCommandHostState = {
  executionHostId: ExecutionHostId
  loadRemote: TerminalQuickCommandHostsSlice['loadRuntimeTerminalQuickCommands'] | null
  remoteConnectionGeneration: number
  remoteEnvironmentId: string | null
  remoteHostId: ExecutionHostId | null
  remoteState: RuntimeTerminalQuickCommands | undefined
  runtimeEnvironments: readonly PublicKnownRuntimeEnvironment[]
  settings: GlobalSettings | null
}

const EMPTY_RUNTIME_ENVIRONMENTS: readonly PublicKnownRuntimeEnvironment[] = []
const DISABLED_TERMINAL_QUICK_COMMAND_HOSTS: TerminalQuickCommandHost[] = []
const DISABLED_TERMINAL_QUICK_COMMAND_HOST_STATE: TerminalQuickCommandHostState = {
  executionHostId: LOCAL_EXECUTION_HOST_ID,
  loadRemote: null,
  remoteConnectionGeneration: 0,
  remoteEnvironmentId: null,
  remoteHostId: null,
  remoteState: undefined,
  runtimeEnvironments: EMPTY_RUNTIME_ENVIRONMENTS,
  settings: null
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

export function useTerminalQuickCommandHosts(
  worktreeId: string,
  enabled = true
): {
  executionHostId: ExecutionHostId
  hosts: TerminalQuickCommandHost[]
  refreshRemoteHost: () => void
  remoteHostLoadFailed: boolean
  remoteHostPending: boolean
} {
  const {
    executionHostId,
    loadRemote,
    remoteConnectionGeneration,
    remoteEnvironmentId,
    remoteHostId,
    remoteState,
    runtimeEnvironments,
    settings
  } = useAppStore(
    useShallow((state): TerminalQuickCommandHostState => {
      if (!enabled) {
        return DISABLED_TERMINAL_QUICK_COMMAND_HOST_STATE
      }
      const executionHostId = getExecutionHostIdForWorktree(state, worktreeId)
      const parsedExecutionHost = parseExecutionHostId(executionHostId)
      const remoteEnvironmentId =
        parsedExecutionHost?.kind === 'runtime' ? parsedExecutionHost.environmentId : null
      return {
        executionHostId,
        loadRemote: state.loadRuntimeTerminalQuickCommands,
        remoteConnectionGeneration: remoteEnvironmentId
          ? (state.runtimeStatusByEnvironmentId.get(remoteEnvironmentId)?.connectionGeneration ?? 0)
          : 0,
        remoteEnvironmentId,
        remoteHostId: parsedExecutionHost?.kind === 'runtime' ? parsedExecutionHost.id : null,
        remoteState: remoteEnvironmentId
          ? state.runtimeTerminalQuickCommands.get(remoteEnvironmentId)
          : undefined,
        runtimeEnvironments: state.runtimeEnvironments,
        settings: state.settings
      }
    })
  )

  useEffect(() => {
    if (loadRemote && remoteEnvironmentId) {
      void loadRemote(remoteEnvironmentId)
    }
  }, [loadRemote, remoteConnectionGeneration, remoteEnvironmentId])

  const refreshRemoteHost = useCallback((): void => {
    if (loadRemote && remoteEnvironmentId) {
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
    if (!enabled) {
      return DISABLED_TERMINAL_QUICK_COMMAND_HOSTS
    }
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
    enabled,
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

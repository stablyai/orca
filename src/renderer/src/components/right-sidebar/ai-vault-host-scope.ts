import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAiVaultResumeWorkspaceExecutionHostId } from '@/lib/ai-vault-resume-target'
import { useAppStore } from '@/store'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  getExecutionHostLabel,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { AiVaultSessionResumeTargetState } from './ai-vault-session-resume'

export type AiVaultHostScopeOption = {
  id: ExecutionHostScope
  label: string
}

export function useAiVaultExecutionHostScope(args: {
  activeWorktreeId: string | null
  resumeTargetState: AiVaultSessionResumeTargetState
  availableExecutionHostScopes?: readonly ExecutionHostScope[]
}): {
  executionHostScope: ExecutionHostScope
  activeExecutionHostScope: ExecutionHostId | null
  onExecutionHostScopeChange: (scope: ExecutionHostScope) => void
} {
  const userChangedHostScopeRef = useRef(false)
  const activeExecutionHostId = useMemo(
    () => getAiVaultResumeWorkspaceExecutionHostId(args.resumeTargetState, args.activeWorktreeId),
    [args.activeWorktreeId, args.resumeTargetState]
  )
  const { activeExecutionHostScope, defaultExecutionHostScope } = resolveAiVaultHostScopeDefaults(
    activeExecutionHostId,
    args.activeWorktreeId
  )
  const [executionHostScope, setExecutionHostScope] =
    useState<ExecutionHostScope>(defaultExecutionHostScope)

  useEffect(() => {
    // Preserve user choices across rerenders; reset only when the new workspace host makes them invalid.
    const allowedScopes = new Set<ExecutionHostScope>([
      LOCAL_EXECUTION_HOST_ID,
      ALL_EXECUTION_HOSTS_SCOPE,
      ...(activeExecutionHostScope ? [activeExecutionHostScope] : []),
      ...(args.availableExecutionHostScopes ?? [])
    ])
    if (!allowedScopes.has(executionHostScope)) {
      setExecutionHostScope(defaultExecutionHostScope)
      userChangedHostScopeRef.current = false
      return
    }
    if (!userChangedHostScopeRef.current && executionHostScope !== defaultExecutionHostScope) {
      setExecutionHostScope(defaultExecutionHostScope)
    }
  }, [
    activeExecutionHostScope,
    args.availableExecutionHostScopes,
    defaultExecutionHostScope,
    executionHostScope
  ])

  const handleExecutionHostScopeChange = useCallback(
    (nextScope: ExecutionHostScope) => {
      userChangedHostScopeRef.current = nextScope !== defaultExecutionHostScope
      setExecutionHostScope(nextScope)
    },
    [defaultExecutionHostScope]
  )

  return {
    executionHostScope,
    activeExecutionHostScope,
    onExecutionHostScopeChange: handleExecutionHostScopeChange
  }
}

/** The panel's host menu: every known host, defaulting to the workspace's own. */
export function useAiVaultPanelHostScope(
  workspaceId: string | null,
  resumeTargetState: AiVaultSessionResumeTargetState
): ReturnType<typeof useAiVaultExecutionHostScope> & {
  hostScopeOptions: AiVaultHostScopeOption[]
} {
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeHostOptions = useMemo(
    () => buildRuntimeAiVaultHostScopeOptions(runtimeEnvironments),
    [runtimeEnvironments]
  )
  const availableExecutionHostScopes = useMemo(
    () => runtimeHostOptions.map((option) => option.id),
    [runtimeHostOptions]
  )
  const hostScope = useAiVaultExecutionHostScope({
    activeWorktreeId: workspaceId,
    resumeTargetState,
    availableExecutionHostScopes
  })
  const { activeExecutionHostScope } = hostScope
  const hostScopeOptions = useMemo(
    () => buildAiVaultHostScopeOptions({ activeExecutionHostScope, runtimeHostOptions }),
    [activeExecutionHostScope, runtimeHostOptions]
  )
  return { ...hostScope, hostScopeOptions }
}

export function resolveAiVaultHostScopeDefaults(
  activeExecutionHostId: ExecutionHostId | null,
  activeWorktreeId: string | null
): {
  activeExecutionHostScope: ExecutionHostId | null
  defaultExecutionHostScope: ExecutionHostScope
} {
  const activeExecutionHost = parseExecutionHostId(activeExecutionHostId)
  const activeExecutionHostScope: ExecutionHostId | null =
    activeExecutionHost?.kind === 'ssh' || activeExecutionHost?.kind === 'runtime'
      ? activeExecutionHost.id
      : null
  // Unknown workspace ownership must widen to all hosts, not falsely report empty local history (#13713).
  const workspaceHostUnresolved = activeWorktreeId !== null && activeExecutionHostId === null
  return {
    activeExecutionHostScope,
    defaultExecutionHostScope:
      activeExecutionHostScope ??
      (workspaceHostUnresolved ? ALL_EXECUTION_HOSTS_SCOPE : LOCAL_EXECUTION_HOST_ID)
  }
}

export function buildRuntimeAiVaultHostScopeOptions(
  runtimeEnvironments: readonly Pick<PublicKnownRuntimeEnvironment, 'id' | 'name'>[]
): AiVaultHostScopeOption[] {
  return runtimeEnvironments.map((environment) => {
    const id = toRuntimeExecutionHostId(environment.id)
    const label = environment.name.trim() || getExecutionHostLabel(id)
    return { id, label }
  })
}

export function buildAiVaultHostScopeOptions(args: {
  activeExecutionHostScope: ExecutionHostId | null
  runtimeHostOptions: readonly AiVaultHostScopeOption[]
}): AiVaultHostScopeOption[] {
  const options: AiVaultHostScopeOption[] = []
  const seen = new Set<ExecutionHostScope>()
  const add = (option: AiVaultHostScopeOption): void => {
    if (seen.has(option.id)) {
      return
    }
    seen.add(option.id)
    options.push(option)
  }
  const activeHost = args.activeExecutionHostScope
    ? parseExecutionHostId(args.activeExecutionHostScope)
    : null

  add({ id: LOCAL_EXECUTION_HOST_ID, label: getExecutionHostLabel(LOCAL_EXECUTION_HOST_ID) })
  if (activeHost?.kind === 'ssh') {
    add({ id: activeHost.id, label: getExecutionHostLabel(activeHost.id) })
  }
  for (const option of args.runtimeHostOptions) {
    add(option)
  }
  if (activeHost?.kind === 'runtime') {
    add({ id: activeHost.id, label: getExecutionHostLabel(activeHost.id) })
  }
  add({ id: ALL_EXECUTION_HOSTS_SCOPE, label: getExecutionHostLabel(ALL_EXECUTION_HOSTS_SCOPE) })

  return options
}

export function useAiVaultSessionHostRefreshEvents(
  error: string | null,
  refresh: (args: { background: boolean; force: boolean }) => Promise<void>
): void {
  const sshConnectedGeneration = useAppStore((s) => s.sshConnectedGeneration)
  const sshGenerationRef = useRef(sshConnectedGeneration)
  useEffect(() => {
    if (sshConnectedGeneration <= sshGenerationRef.current) {
      return
    }
    sshGenerationRef.current = sshConnectedGeneration
    if (error !== null) {
      void refresh({ background: true, force: false })
    }
  }, [sshConnectedGeneration, error, refresh])

  // Refocus checks the shared host cache without forcing another transcript scan.
  useEffect(() => {
    const onRefocus = (): void => {
      if (document.visibilityState !== 'visible') {
        return
      }
      void refresh({ background: true, force: false })
    }
    const unsubscribeWindowFocus = window.api.aiVault.onWindowFocused?.(onRefocus)
    document.addEventListener('visibilitychange', onRefocus)
    return () => {
      unsubscribeWindowFocus?.()
      document.removeEventListener('visibilitychange', onRefocus)
    }
  }, [refresh])
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { getAiVaultResumeWorkspaceExecutionHostId } from '@/lib/ai-vault-resume-target'
import {
  isRuntimeOwnedSshTargetId,
  ALL_EXECUTION_HOSTS_SCOPE,
  getExecutionHostLabel,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
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
  const activeExecutionHost = parseExecutionHostId(activeExecutionHostId)
  const activeExecutionHostScope: ExecutionHostId | null =
    activeExecutionHost?.kind === 'ssh' || activeExecutionHost?.kind === 'runtime'
      ? activeExecutionHost.id
      : null
  // Why: a named workspace whose host the client store cannot place is `unverifiable`, not local.
  // Defaulting it to local scanned the desktop's own history and reported "No agent sessions found"
  // for a user whose sessions all live on an SSH host (#13713). Widen to every host instead of
  // asserting one. A local workspace still resolves to `local` and is unaffected.
  const workspaceHostUnresolved = args.activeWorktreeId !== null && activeExecutionHostId === null
  const defaultExecutionHostScope: ExecutionHostScope =
    activeExecutionHostScope ??
    (workspaceHostUnresolved ? ALL_EXECUTION_HOSTS_SCOPE : LOCAL_EXECUTION_HOST_ID)
  const [executionHostScope, setExecutionHostScope] =
    useState<ExecutionHostScope>(defaultExecutionHostScope)

  useEffect(() => {
    // Why: preserve an explicit user choice (e.g. "All") across incidental
    // rerenders, but reset to the new default once that choice no longer
    // applies to the active worktree's host.
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

export function buildRuntimeAiVaultHostScopeOptions(
  runtimeEnvironments: readonly Pick<PublicKnownRuntimeEnvironment, 'id' | 'name'>[]
): AiVaultHostScopeOption[] {
  return runtimeEnvironments.map((environment) => {
    const id = toRuntimeExecutionHostId(environment.id)
    const label = environment.name.trim() || getExecutionHostLabel(id)
    return { id, label }
  })
}

/** Connected SSH targets, labelled with the name the user gave them (never the internal id). */
export function buildSshAiVaultHostScopeOptions(args: {
  sshTargetLabels: ReadonlyMap<string, string> | undefined
  sshConnectionStates: ReadonlyMap<string, { status: SshConnectionStatus }> | undefined
}): AiVaultHostScopeOption[] {
  const options: AiVaultHostScopeOption[] = []
  for (const [targetId, state] of args.sshConnectionStates ?? []) {
    // Why connected only: an SSH host's history is read through its live relay, so a
    // disconnected target could only ever answer with a scan issue.
    // Why skip runtime-owned targets: they belong to a paired Orca server's session, not to this desktop.
    if (state.status !== 'connected' || isRuntimeOwnedSshTargetId(targetId)) {
      continue
    }
    const id = toSshExecutionHostId(targetId)
    options.push({
      id,
      label: args.sshTargetLabels?.get(targetId)?.trim() || getExecutionHostLabel(id)
    })
  }
  return options.sort((a, b) => a.label.localeCompare(b.label))
}

export function buildAiVaultHostScopeOptions(args: {
  activeExecutionHostScope: ExecutionHostId | null
  runtimeHostOptions: readonly AiVaultHostScopeOption[]
  sshHostOptions?: readonly AiVaultHostScopeOption[]
  /** Labels of every known SSH target, so the active host keeps its name while disconnected. */
  sshTargetLabels?: ReadonlyMap<string, string>
  /** Last-known labels of removed SSH targets, so a removed active host is still named. */
  removedSshTargetLabels?: ReadonlyMap<string, string>
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
  const sshHostOptions = args.sshHostOptions ?? []
  if (activeHost?.kind === 'ssh') {
    const named = sshHostOptions.find((option) => option.id === activeHost.id)
    const label =
      args.sshTargetLabels?.get(activeHost.targetId)?.trim() ||
      args.removedSshTargetLabels?.get(activeHost.targetId)?.trim() ||
      getExecutionHostLabel(activeHost.id)
    add(named ?? { id: activeHost.id, label })
  }
  for (const option of sshHostOptions) {
    add(option)
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

/** Remote hosts the Session History can scope to: saved Orca servers and connected SSH targets. */
export function useAiVaultRemoteHostOptions(): {
  runtimeHostOptions: AiVaultHostScopeOption[]
  sshHostOptions: AiVaultHostScopeOption[]
  sshTargetLabels: ReadonlyMap<string, string> | undefined
  removedSshTargetLabels: ReadonlyMap<string, string> | undefined
  availableExecutionHostScopes: ExecutionHostScope[]
} {
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const removedSshTargetLabels = useAppStore((s) => s.removedSshTargetLabels)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  return useMemo(() => {
    const runtimeHostOptions = buildRuntimeAiVaultHostScopeOptions(runtimeEnvironments)
    const sshHostOptions = buildSshAiVaultHostScopeOptions({ sshTargetLabels, sshConnectionStates })
    return {
      runtimeHostOptions,
      sshHostOptions,
      sshTargetLabels,
      removedSshTargetLabels,
      availableExecutionHostScopes: [...sshHostOptions, ...runtimeHostOptions].map((o) => o.id)
    }
  }, [runtimeEnvironments, sshTargetLabels, removedSshTargetLabels, sshConnectionStates])
}

export type AgentWorkspaceTrustSettings = {
  /** Off: never pre-trust. On: pre-trust unless the repo opted out. Defaults on. */
  agentWorkspaceTrustEnabled: boolean
  /** One-shot guard: repos saved before per-repo trust decisions were pinned to pre-trust. */
  agentWorkspaceTrustExistingReposMigrated?: boolean
}

/** Per-repo answer to "should Orca pre-trust this repo for agents?"; worktrees share their repo's answer. */
export type AgentWorkspaceTrustDecision = 'pre-trust' | 'agent-asks'

export function sanitizeAgentWorkspaceTrustDecision(
  value: unknown
): AgentWorkspaceTrustDecision | undefined {
  return value === 'pre-trust' || value === 'agent-asks' ? value : undefined
}

/** Global off always wins; a repo is pre-trusted unless it opted out. */
export function shouldPreTrustAgentWorkspace(
  globalEnabled: boolean | undefined,
  repoDecision: AgentWorkspaceTrustDecision | undefined
): boolean {
  return globalEnabled !== false && repoDecision !== 'agent-asks'
}

export function resolveAgentWorkspaceTrustOwner(args: {
  worktreeId?: string
  trustWorktreeId?: string
}): string | undefined {
  return args.trustWorktreeId ?? args.worktreeId
}

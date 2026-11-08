export type AgentWorkspaceTrustSettings = {
  /** Off: never pre-trust. On: pre-trust per each repo's decision (asked on first desktop launch). Defaults on. */
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

/** Global off always wins; an undecided repo keeps the pre-existing pre-trust default so unattended launches never stall. */
export function shouldPreTrustAgentWorkspace(
  globalEnabled: boolean | undefined,
  repoDecision: AgentWorkspaceTrustDecision | undefined
): boolean {
  return globalEnabled !== false && repoDecision !== 'agent-asks'
}

/** Only a launch the user is watching asks; it must settle before the spawn reads the answer. */
export function needsAgentWorkspaceTrustDecision(
  globalEnabled: boolean | undefined,
  repoDecision: AgentWorkspaceTrustDecision | undefined
): boolean {
  return globalEnabled !== false && repoDecision === undefined
}

export function resolveAgentWorkspaceTrustOwner(args: {
  worktreeId?: string
  trustWorktreeId?: string
}): string | undefined {
  return args.trustWorktreeId ?? args.worktreeId
}

// Why: only these agents' re-entered Stop (`stop_hook_active`) is verified first-hand (Claude by
// lane capture, Codex by source). The host reads no other agent's flag, so their repeats stay
// ambiguous ends.
const STOP_HOOK_CONTINUATION_AGENTS: ReadonlySet<string> = new Set(['claude', 'codex'])

export function agentReportsStopHookContinuation(agent: string | null | undefined): boolean {
  return agent !== null && agent !== undefined && STOP_HOOK_CONTINUATION_AGENTS.has(agent)
}

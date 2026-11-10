// Only Claude (lane capture) and Codex (source) verify stop_hook_active re-entry; other agents' repeated Stops remain ambiguous ends.
const STOP_HOOK_CONTINUATION_AGENTS: ReadonlySet<string> = new Set(['claude', 'codex'])

export function agentReportsStopHookContinuation(agent: string | null | undefined): boolean {
  return agent !== null && agent !== undefined && STOP_HOOK_CONTINUATION_AGENTS.has(agent)
}

/** A window rename names the local host's Claude pane in that tab, as `/rename` would. */
export function syncLocalClaudeSessionName(tabId: string, title: string | null): void {
  // Windows without a local runtime (paired web clients) name tabs on their host instead.
  const runtime = typeof window === 'undefined' ? undefined : window.api?.runtime
  if (!runtime?.call || !title?.trim()) {
    return
  }
  void runtime
    .call({ method: 'terminal.syncAgentSessionName', params: { tabId, title } })
    .catch(() => {})
}

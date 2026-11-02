/** A window rename names the local host's Claude pane in that tab, as `/rename` would; a clear withdraws a pending one. */
export function syncLocalClaudeSessionName(tabId: string, title: string | null): void {
  // Windows without a local runtime (paired web clients) name tabs on their host instead.
  const runtime = typeof window === 'undefined' ? undefined : window.api?.runtime
  if (!runtime?.call) {
    return
  }
  // Best effort: a rename never fails on the session-name side.
  void Promise.resolve()
    .then(() =>
      runtime.call({
        method: 'terminal.syncAgentSessionName',
        params: { tabId, title: title?.trim() ? title : null }
      })
    )
    .catch(() => {})
}

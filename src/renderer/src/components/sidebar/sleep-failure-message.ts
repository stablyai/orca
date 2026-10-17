import { translate } from '@/i18n/i18n'

/** The toast line for one workspace whose sleep failed; the workspace stays open. */
export function describeSleepFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  // Why first: the twin refusal names no connection problem, though it contains "terminal_".
  if (detail.includes('ambiguous_terminal_owner')) {
    return translate(
      'auto.components.sidebar.sleep.worktree.flow.twin.unattributed',
      "Orca couldn't tell which host runs this workspace's terminals, so the workspace was kept open. Reconnect its hosts and try again."
    )
  }
  if (detail.includes('legacy')) {
    return translate(
      'auto.components.sidebar.sleep.worktree.flow.legacy.unverified',
      'The older host runtime could not confirm terminal shutdown. The workspace was kept open; update the host and try again.'
    )
  }
  if (
    detail.includes('terminal_') ||
    detail.includes('runtime') ||
    detail.includes('connection') ||
    detail.includes('Daemon')
  ) {
    return translate(
      'auto.components.sidebar.sleep.worktree.flow.host.unverified',
      'The host could not confirm terminal shutdown. The workspace was kept open; check the connection and try again.'
    )
  }
  return translate(
    'auto.components.sidebar.sleep.worktree.flow.retry',
    'The workspace was kept open. Try again; if the problem continues, check the host connection.'
  )
}

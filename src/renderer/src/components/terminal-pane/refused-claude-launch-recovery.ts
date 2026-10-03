import { ACTIVE_CLAUDE_ACCOUNT } from '../../../../shared/claude/project-claude-account-preference'
import { readClaudePinnedLaunchErrorCode } from '../../../../shared/claude/claude-pinned-launch-error'
import type { PtyPaneStartup } from './pty-connection-types'

type RefusedStartup = NonNullable<PtyPaneStartup>

// Why a WeakMap on the pane's stable transports ref: a new hook would shift TerminalPane's
// hook order, and the map must live exactly as long as that pane host.
const refusedStartupsByPaneHost = new WeakMap<object, Map<number, RefusedStartup>>()

export function refusedClaudeLaunchStartupsFor(paneHost: object): Map<number, RefusedStartup> {
  let startups = refusedStartupsByPaneHost.get(paneHost)
  if (!startups) {
    startups = new Map()
    refusedStartupsByPaneHost.set(paneHost, startups)
  }
  return startups
}

/** Keeps the spawn a pinned-account refusal belongs to, so recovery can replay it in the same pane. */
export function recordRefusedClaudeLaunchStartup(
  refusedStartups: Map<number, RefusedStartup>,
  paneId: number,
  message: string,
  startup: PtyPaneStartup | undefined
): void {
  if (startup && readClaudePinnedLaunchErrorCode(message)) {
    refusedStartups.set(paneId, startup)
  }
}

/**
 * Whether activating a PTY-less pane should hand focus to a PTY-backed sibling. A refused pane
 * never gets a PTY, and the error toast follows the active pane, so it must stay activatable.
 */
export function redirectsPtylessPaneActivation(input: {
  ptyIdsByLeafId: Record<string, string>
  leafId: string
  paneId: number
  refusedStartups: Map<number, RefusedStartup>
}): boolean {
  return (
    Object.keys(input.ptyIdsByLeafId).length > 0 &&
    !input.ptyIdsByLeafId[input.leafId] &&
    !input.refusedStartups.has(input.paneId)
  )
}

export function withActiveClaudeAccount(startup: RefusedStartup): RefusedStartup {
  return {
    ...startup,
    launchConfig: {
      ...(startup.launchConfig ?? { agentArgs: '', agentEnv: {} }),
      claudeAccountId: ACTIVE_CLAUDE_ACCOUNT
    }
  }
}

type RefusedPaneReplay = {
  paneId: number
  refusedStartups: Map<number, RefusedStartup>
  restartPane: (paneId: number, startup: PtyPaneStartup) => void
}

/**
 * Restarts only the refused pane, keeping its prompt, args and resume session, so split siblings
 * keep running. Returns false when no refused spawn was recorded for the pane.
 */
export function replayRefusedClaudeLaunch(
  input: RefusedPaneReplay & { onActiveAccount: boolean }
): boolean {
  const refused = input.refusedStartups.get(input.paneId)
  input.refusedStartups.delete(input.paneId)
  if (!refused) {
    return false
  }
  input.restartPane(
    input.paneId,
    input.onActiveAccount ? withActiveClaudeAccount(refused) : refused
  )
  return true
}

/** Without a recorded spawn to replay in place, opens a new tab instead. */
export function startRefusedPaneOnActiveClaudeAccount(
  input: RefusedPaneReplay & { openNewTab: () => void }
): void {
  if (!replayRefusedClaudeLaunch({ ...input, onActiveAccount: true })) {
    input.openNewTab()
  }
}

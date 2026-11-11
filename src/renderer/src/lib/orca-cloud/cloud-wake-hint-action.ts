// What the woke-up strip's one button does (JA-15). A shell pane retypes its own command; an agent
// pane runs the agent's Restart (the RA-11 path, with its no-conversation fresh fallback), never a
// retyped launch line: Orca's launch script deletes itself and resumes a conversation that may be gone.
import { HOST_AGENT_SIGN_IN_AGENT_NAME } from '../../../../shared/host-agent-sign-in-status'
import type { CloudWokeAction } from '@/components/orca-cloud/offline/CloudWokeProcessesNotice'
import type { WakeProcessHint } from './cloud-wake-process-hints'
import { restartCloudPaneAgent } from './cloud-pane-agent-restart'

/** The strip's button for a hint: Rerun with the command, or Restart with the agent's name. */
export function cloudWokeActionFor(hint: WakeProcessHint): CloudWokeAction {
  return 'command' in hint
    ? { kind: 'rerun', command: hint.command }
    : { kind: 'restart', agent: HOST_AGENT_SIGN_IN_AGENT_NAME[hint.restartAgent] }
}

export function runCloudWokeAction(
  hint: WakeProcessHint,
  pane: {
    tabId: string
    leafId: string
    worktreeId: string
    /** Types into the pane's shell. */
    sendInput: (data: string) => void
  },
  restart: typeof restartCloudPaneAgent = restartCloudPaneAgent
): void {
  if ('command' in hint) {
    pane.sendInput(`${hint.command}\r`)
    return
  }
  // Interim until agents relaunch themselves on wake (WAKE-1).
  restart({
    tabId: pane.tabId,
    leafId: pane.leafId,
    worktreeId: pane.worktreeId,
    agent: hint.restartAgent
  })
}

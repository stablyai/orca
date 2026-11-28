import type { PtyRunningWorkProbe } from '../../terminal/pty/lifecycle/pty-running-work-probe'
import { recognizeAgentProcess } from '../../agent-status/process/agent-process-recognition'
import {
  chatAgentsShareConversations,
  type CliConversationRowAgent
} from './structured-agent-cli-conversation-adoption'

/** keep: the agent quit, so the terminal stays; close: continuing stops the pane's agent;
 *  ask: the pane runs another job, so the user is asked before it is stopped. */
export type CliChatResumeClose = 'keep' | 'close' | 'ask'

/** Only the host's proof that the pane's shell runs nothing shows its agent quit; a CLI has no
 *  status row before its first hook, so anything short of that proof closes. */
export function cliChatResumeCloseFromProbe(
  probe: PtyRunningWorkProbe | undefined,
  agent: CliConversationRowAgent
): CliChatResumeClose {
  if (probe?.verdict === 'exited') {
    return 'keep'
  }
  // Only this conversation's agent is the user's to stop; a job started after it quit (an editor,
  // a dev server, another agent) is asked about first.
  const running = probe?.verdict === 'live' ? probe.foregroundProcess : undefined
  const runningAgent = running ? recognizeAgentProcess(running)?.agent : undefined
  return running && !(runningAgent && chatAgentsShareConversations(agent, runningAgent))
    ? 'ask'
    : 'close'
}

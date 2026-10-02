import {
  isSameAgentProcess,
  type AgentProcessPresence
} from '../../../../shared/agent-process-presence'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { isLegacyUnidentified } from '@/lib/legacy-unidentified-agent-presence'
import type { ProcessMonitorOptions } from './agent-completion-process-types'

/** A live identified owner is the host's to judge: a trigger asks its exact check, nothing polls.
 *  Undefined admits the temporary legacy inspection. */
export function inspectAgentCompletionHostPresence({
  options,
  state,
  establishAgentEvidence
}: ProcessMonitorOptions): Promise<boolean> | undefined {
  const owner = options.getAgentPresence?.()
  const expected = owner?.process
  if (!expected || isLegacyUnidentified(owner)) {
    return undefined
  }
  return (async () => {
    const verdict = (await options.checkAgentPresence?.(expected)) ?? 'unverifiable'
    const current = options.getAgentPresence?.()
    if (
      state.disposed ||
      isLegacyUnidentified(current) ||
      !current?.process ||
      !isSameAgentProcess(expected, current.process)
    ) {
      return false
    }
    state.pendingProcessExit = null
    // Why: an exit reaches this pane as the host's published ended owner, never from this reply.
    if (verdict !== 'live') {
      return false
    }
    establishAgentEvidence()
    return true
  })()
}

/** The mirrored host exit is this pane's one process-exit completion. */
export function createAgentOwnerExitObserver({
  options,
  state,
  clearAgentRunEvidence,
  dispatchCompletion,
  scheduleNextPoll
}: Pick<
  ProcessMonitorOptions,
  'options' | 'state' | 'clearAgentRunEvidence' | 'dispatchCompletion'
> & {
  scheduleNextPoll: () => void
}): (presence: AgentProcessPresence | undefined) => void {
  let observed = options.getAgentPresence?.()
  return (presence) => {
    const previous = observed
    if (presence === previous) {
      return
    }
    observed = presence
    const exited = presence?.process
    if (
      state.disposed ||
      !exited ||
      !presence.ended ||
      !previous?.process ||
      previous.ended ||
      !isSameAgentProcess(previous.process, exited)
    ) {
      return
    }
    const agent = isTuiAgent(presence.agent) ? presence.agent : null
    state.lastForegroundAgent = null
    if (agent && state.hasAgentRunEvidence && options.isLive()) {
      dispatchCompletion('process-exit', agent, {
        terminalIdleConfirmed: true,
        // Why: a resumed owner that exits without ever working has nothing to announce.
        requiresUnnotifiedTurn: true,
        completionIdentity: {
          source: 'process-exit',
          identity: `${exited.platform}:${exited.pid}:${exited.startTime}`,
          agentIdentity: agent
        }
      })
      options.onForegroundAgentExited?.({ agent, processName: agent })
    }
    clearAgentRunEvidence()
    scheduleNextPoll()
  }
}

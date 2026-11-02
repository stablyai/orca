import type { TuiAgent } from '../../../../../shared/tui-agent'
import {
  addStructuredLaunchCaller,
  type StructuredAgentLaunchOptions,
  type StructuredLaunchCaller
} from './structured-agent-session-launch-callers'
import { seedStructuredAgentLaunchDraft } from './structured-agent-session-launch-draft'
import {
  getStructuredLaunchStateBySessionId,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'

/** A host launch this window still holds, whatever became of it: a start of it again only shows
 *  it, and an unknown or failed one is read again; nothing is staged or accepted a second time. */
export function joinHeldHostLaunch(
  worktreeId: string,
  agent: TuiAgent,
  options: StructuredAgentLaunchOptions,
  readAgain: (state: StructuredLaunchState) => void
): { state: StructuredLaunchState; caller: StructuredLaunchCaller; joined: true } | undefined {
  const held =
    options.hostLaunch && getStructuredLaunchStateBySessionId(options.hostLaunch.sessionId)
  if (
    !held ||
    held.cancelled ||
    held.intent.worktreeId !== worktreeId ||
    held.intent.agent !== agent
  ) {
    return undefined
  }
  if (held.visibilityUnknown || held.callers.outcome === 'failed') {
    readAgain(held)
  }
  if (options.draftFromScope) {
    // Only what was typed where the launch's chat was not shown; the chat's own draft stays first.
    seedStructuredAgentLaunchDraft(held, {
      requestId: options.requestId,
      draftFromScope: options.draftFromScope
    })
  }
  const { prompt: _sent, ...rest } = options
  const caller = addStructuredLaunchCaller({
    group: held.callers,
    launchResult: held.promise,
    target: held.intent.target,
    options: rest,
    stagedPrompt: null
  })
  return { state: held, caller, joined: true }
}

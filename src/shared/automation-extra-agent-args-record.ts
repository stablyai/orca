import { automationCanonicalLaunchSetup } from './automation-launch-setup'
import { automationLaunchInputs } from './automation-launch-setup-source'
import type { Automation } from './automations-types'
import {
  EXTRA_AGENT_ARGS_REQUIRE_FRESH_SESSION,
  hasExtraAgentArgs,
  parseExtraAgentArgs
} from './agent-launch/startup/automation-extra-agent-args'

/** Stored form of an extras input: the text unchanged, or `undefined` when it holds no extras. */
export function storedExtraAgentArgs(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error('Extra agent arguments must be text.')
  }
  return hasExtraAgentArgs(value) ? value : undefined
}

/** Validates a whole record, so a patch that only enables Reuse still sees stored extras. */
export function assertAutomationExtraAgentArgs(
  automation: Pick<
    Automation,
    | 'agentId'
    | 'extraAgentArgs'
    | 'reuseSession'
    | 'surface'
    | 'launchPreferences'
    | 'agentArgs'
    | 'launchSetup'
  >
): void {
  const setup = automationCanonicalLaunchSetup(automation)
  const views = automationLaunchInputs(automation.agentId, setup)
  const consumed =
    setup.surface === 'chat'
      ? Object.keys(views.chatSessionOptions ?? {}).length > 0
      : setup.agentArgs !== undefined || Object.keys(views.sessionOptions ?? {}).length > 0
  if (automation.reuseSession && consumed) {
    throw new Error('Agent launch settings require a fresh session for every run.')
  }
  if (automation.surface === 'chat' || !hasExtraAgentArgs(setup.extraAgentArgs)) {
    return
  }
  if (automation.reuseSession) {
    throw new Error(EXTRA_AGENT_ARGS_REQUIRE_FRESH_SESSION)
  }
  const parsed = parseExtraAgentArgs({
    agent: automation.agentId,
    extraAgentArgs: setup.extraAgentArgs
  })
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
}

import type { Automation } from './automations-types'
import { hasExtraAgentArgs, parseExtraAgentArgs } from './automation-extra-agent-args'

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

/** Validates launch arguments even when a patch leaves stored extras unchanged. */
export function assertAutomationExtraAgentArgs(
  automation: Pick<Automation, 'agentId' | 'extraAgentArgs' | 'reuseSession' | 'surface'>
): void {
  if (automation.surface === 'chat' || !hasExtraAgentArgs(automation.extraAgentArgs)) {
    return
  }
  const parsed = parseExtraAgentArgs({
    agent: automation.agentId,
    extraAgentArgs: automation.extraAgentArgs
  })
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
}

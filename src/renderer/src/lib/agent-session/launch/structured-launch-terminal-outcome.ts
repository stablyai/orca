import type { AgentTabLaunchOutcome } from '@/lib/launch-agent-in-new-tab-host-agents'
import type { StructuredLaunchTerminal } from './structured-agent-session-launch-admission'

/** The terminal a declined chat's fallback opened, read from the new-tab launcher's outcome. */
export function structuredLaunchTerminalFromOutcome(
  result: AgentTabLaunchOutcome
): StructuredLaunchTerminal {
  if (result && 'refused' in result) {
    return {
      opened: false,
      promptDeliveryResult: Promise.resolve(result.refused),
      ...(result.recovery ? { refusal: result.recovery } : {})
    }
  }
  return {
    opened: result !== null,
    ...(result?.surface.kind === 'local-terminal' ? { tabId: result.surface.tabId } : {}),
    ...(result?.terminalCompletion ? { completion: result.terminalCompletion } : {}),
    ...(result?.promptDeliveryResult ? { promptDeliveryResult: result.promptDeliveryResult } : {})
  }
}

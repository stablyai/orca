import type { TuiAgentConfig } from '../../../shared/tui-agent-config'

// Why: agents with a native draft-prefill flag/env launch with the prompt
// already in their input box, so the paste helpers intentionally no-op (return
// false) unless `forcePaste` overrides. Callers pass the resolved base config
// (a custom id inherits its base's prefill behavior); callers use this to tell
// "delivered natively" apart from a real paste failure.
export function agentDeliversDraftViaNativePrefill(
  agentConfig: TuiAgentConfig | null,
  forcePaste: boolean | undefined
): boolean {
  if (forcePaste) {
    return false
  }
  return Boolean(agentConfig?.draftPromptFlag || agentConfig?.draftPromptEnvVar)
}

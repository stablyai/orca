import { track } from '@/lib/telemetry'
import type { SetupScriptPromptInspection } from '@/lib/setup-script-prompt'
import { buildSetupScriptPromptTelemetry } from '../../../../shared/setup-script-telemetry'

export function trackSetupScriptPromptExposure(input: {
  repoId: string
  promptState: SetupScriptPromptInspection | null
  trackedPromptKeys: Set<string>
}): void {
  const { promptState, repoId, trackedPromptKeys } = input
  if (
    promptState?.repoId !== repoId ||
    promptState.status !== 'ok' ||
    promptState.hasEffectiveSetup
  ) {
    return
  }

  const telemetry = buildSetupScriptPromptTelemetry({
    candidate: promptState.candidate,
    hasSharedHooks: promptState.hasSharedHooks
  })
  // Why: React may re-render the sidebar often; this event should represent
  // a distinct prompt exposure for this repo/source, not render churn.
  const promptKey = [
    repoId,
    telemetry.mode,
    telemetry.provider ?? 'none',
    telemetry.file_count_bucket,
    telemetry.unsupported_field_count_bucket,
    String(telemetry.has_shared_hooks)
  ].join(':')
  if (trackedPromptKeys.has(promptKey)) {
    return
  }

  trackedPromptKeys.add(promptKey)
  track('setup_script_prompt_shown', telemetry)
}

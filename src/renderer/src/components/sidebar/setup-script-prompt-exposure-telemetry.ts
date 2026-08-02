import { track } from '@/lib/telemetry'
import { buildSetupScriptPromptTelemetry } from '../../../../shared/setup-script-telemetry'
import type { SetupScriptPromptState } from './setup-script-prompt-render-state'

export function trackSetupScriptPromptExposure(input: {
  repoId: string
  repoHostIdentity: string
  promptState: SetupScriptPromptState | null
  trackedPromptKeys: Set<string>
}): void {
  const { promptState, repoHostIdentity, repoId, trackedPromptKeys } = input
  if (
    promptState?.repoId !== repoId ||
    promptState.repoHostIdentity !== repoHostIdentity ||
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
    repoHostIdentity,
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

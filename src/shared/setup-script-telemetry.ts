import type { EventProps } from './telemetry-events'
import type { SetupScriptImportCandidate } from './setup-script-imports'

type SetupScriptPromptTelemetry = Omit<EventProps<'setup_script_prompt_shown'>, 'nth_repo_added'>
type SetupScriptPromptActionTelemetry = Omit<
  EventProps<'setup_script_prompt_action'>,
  'nth_repo_added'
>

export type SetupScriptPromptAction = SetupScriptPromptActionTelemetry['action']

export function buildSetupScriptPromptTelemetry({
  candidate,
  hasSharedHooks
}: {
  candidate: SetupScriptImportCandidate | null
  hasSharedHooks: boolean
}): SetupScriptPromptTelemetry {
  const base = {
    mode: candidate ? 'import_available' : 'configure_needed',
    file_count_bucket: bucketSetupScriptCount(candidate?.files.length ?? 0),
    unsupported_field_count_bucket: bucketSetupScriptCount(
      candidate?.unsupportedFields?.length ?? 0
    ),
    has_shared_hooks: hasSharedHooks
  } satisfies SetupScriptPromptTelemetry

  return candidate ? { ...base, provider: candidate.provider } : base
}

export function buildSetupScriptPromptActionTelemetry({
  action,
  candidate,
  hasSharedHooks
}: {
  action: SetupScriptPromptAction
  candidate: SetupScriptImportCandidate | null
  hasSharedHooks: boolean
}): SetupScriptPromptActionTelemetry {
  return {
    ...buildSetupScriptPromptTelemetry({ candidate, hasSharedHooks }),
    action
  }
}

function bucketSetupScriptCount(count: number): SetupScriptPromptTelemetry['file_count_bucket'] {
  if (count <= 0) {
    return '0'
  }
  if (count === 1) {
    return '1'
  }
  if (count <= 3) {
    return '2-3'
  }
  return '4+'
}

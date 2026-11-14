import { translate } from '@/i18n/i18n'

type CopyValues = Record<string, string | number>

// Merged into the text-generation copy table, which is at its size budget; fallbacks repeat TEXT_GENERATION_FAILURE_COPY.
export const DICTATION_CLEANUP_ERROR_COPY = {
  commandTemplateEmptyDictationCleanup: (values: CopyValues) =>
    translate(
      'sourceControl.textGeneration.errors.commandTemplateEmptyDictationCleanup',
      'Command template is empty for dictation cleanup.',
      values
    ),
  dictationCleanupAgentUnsupported: (values: CopyValues) =>
    translate(
      'sourceControl.textGeneration.errors.dictationCleanupAgentUnsupported',
      'Choose a supported agent for AI cleanup in Settings -> Voice -> Cleanup. Supported agents: {{agents}}, or Custom command.',
      values
    ),
  agentCannotGenerateDictationCleanup: (values: CopyValues) =>
    translate(
      'sourceControl.textGeneration.errors.agentCannotGenerateDictationCleanup',
      'Agent "{{agent}}" does not support dictation cleanup. Supported agents: {{agents}}, or Custom command.',
      values
    )
}

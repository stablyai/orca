import { translate } from '@/i18n/i18n'
import type { StructuredAgentSessionCommandOutcome } from '../../../../shared/structured-agent-session-composer'
import {
  STRUCTURED_COMPOSER_FAILURE_COPY as EN,
  type StructuredComposerFailureCode
} from '../../../../shared/structured-agent-session-composer-failure'

const COPY: Record<StructuredComposerFailureCode, (name: string, value: string) => string> = {
  goalObjectiveMissing: () =>
    translate(
      'components.native-chat.composerErrors.goalObjectiveMissing',
      EN.goalObjectiveMissing
    ),
  commandUnavailable: (name) =>
    translate('components.native-chat.composerErrors.commandUnavailable', EN.commandUnavailable, {
      name
    }),
  commandTakesNoArguments: (name) =>
    translate(
      'components.native-chat.composerErrors.commandTakesNoArguments',
      EN.commandTakesNoArguments,
      { name }
    ),
  commandUnsupportedByHost: (name) =>
    translate(
      'components.native-chat.composerErrors.commandUnsupportedByHost',
      EN.commandUnsupportedByHost,
      { name }
    ),
  modelPickerFailed: () =>
    translate('components.native-chat.composerErrors.modelPickerFailed', EN.modelPickerFailed),
  effortPickerFailed: () =>
    translate('components.native-chat.composerErrors.effortPickerFailed', EN.effortPickerFailed),
  modelApplyFailed: (_name, value) =>
    translate('components.native-chat.composerErrors.modelApplyFailed', EN.modelApplyFailed, {
      value
    }),
  effortApplyFailed: (_name, value) =>
    translate('components.native-chat.composerErrors.effortApplyFailed', EN.effortApplyFailed, {
      value
    })
}

/** Translate refusals the shared composer worded; other errors arrive already translated. */
export function localizeStructuredComposerOutcome(
  outcome: StructuredAgentSessionCommandOutcome
): StructuredAgentSessionCommandOutcome {
  const code = outcome.errorCode
  if (outcome.error === null || code === undefined) {
    return outcome
  }
  const params = outcome.errorParams ?? {}
  return { ...outcome, error: COPY[code](params.name ?? '', params.value ?? '') }
}

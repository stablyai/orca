import { translate } from '@/i18n/i18n'
import {
  EXTRA_AGENT_ARGS_FAILURE_COPY as EN,
  type ExtraAgentArgsFailure,
  type ExtraAgentArgsFailureCode
} from '../../../../shared/automation-extra-agent-args'

const COPY: Record<ExtraAgentArgsFailureCode, (params: Record<string, string>) => string> = {
  unsupportedAgent: () =>
    translate('auto.components.automations.extraAgentArgs.unsupported', EN.unsupportedAgent),
  tooLarge: () => translate('automations.extraAgentArgs.errors.tooLarge', EN.tooLarge),
  controlCharacters: () =>
    translate('automations.extraAgentArgs.errors.controlCharacters', EN.controlCharacters),
  invalid: (params) => translate('automations.extraAgentArgs.errors.invalid', EN.invalid, params),
  shellSyntax: (params) =>
    translate('automations.extraAgentArgs.errors.shellSyntax', EN.shellSyntax, params),
  terminator: () => translate('automations.extraAgentArgs.errors.terminator', EN.terminator),
  notAnOption: (params) =>
    translate('automations.extraAgentArgs.errors.notAnOption', EN.notAnOption, params),
  optionNotAllowed: (params) =>
    translate('automations.extraAgentArgs.errors.optionNotAllowed', EN.optionNotAllowed, params),
  missingValue: (params) =>
    translate('automations.extraAgentArgs.errors.missingValue', EN.missingValue, params),
  valueNotAllowed: (params) =>
    translate('automations.extraAgentArgs.errors.valueNotAllowed', EN.valueNotAllowed, params),
  modelRepeated: () =>
    translate('automations.extraAgentArgs.errors.modelRepeated', EN.modelRepeated),
  effortRepeated: () =>
    translate('automations.extraAgentArgs.errors.effortRepeated', EN.effortRepeated)
}

// Parsed in this renderer, so every failure carries its code and params.
export function extraAgentArgsErrorText(failure: ExtraAgentArgsFailure): string {
  return COPY[failure.errorCode](failure.errorParams ?? {})
}

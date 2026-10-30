import { translate } from '@/i18n/i18n'
import {
  SESSION_OPTION_APPLY_FAILURE_COPY as EN,
  type SessionOptionApplyError,
  type SessionOptionApplyFailureCode
} from '../../../../shared/native-chat-session-option-apply-failure'

const COPY: Record<SessionOptionApplyFailureCode, (id: string) => string> = {
  startOnly: () => translate('components.native-chat.sessionOptionErrors.startOnly', EN.startOnly),
  modelRejected: () =>
    translate('components.native-chat.sessionOptionErrors.modelRejected', EN.modelRejected),
  modelUnverified: () =>
    translate('components.native-chat.sessionOptionErrors.modelUnverified', EN.modelUnverified),
  unknownOption: (id) =>
    translate('components.native-chat.sessionOptionErrors.unknownOption', EN.unknownOption, {
      id
    }),
  agentPickerOnly: () =>
    translate('components.native-chat.sessionOptionErrors.agentPickerOnly', EN.agentPickerOnly),
  toggleBaselineUnknown: () =>
    translate(
      'components.native-chat.sessionOptionErrors.toggleBaselineUnknown',
      EN.toggleBaselineUnknown
    ),
  afterStartOnly: () =>
    translate('components.native-chat.sessionOptionErrors.afterStartOnly', EN.afterStartOnly),
  valueRequired: () =>
    translate('components.native-chat.sessionOptionErrors.valueRequired', EN.valueRequired),
  toggleValueKnown: () =>
    translate('components.native-chat.sessionOptionErrors.toggleValueKnown', EN.toggleValueKnown)
}

export function sessionOptionApplyErrorText(error: SessionOptionApplyError): string {
  return COPY[error.code](error.optionId ?? '')
}

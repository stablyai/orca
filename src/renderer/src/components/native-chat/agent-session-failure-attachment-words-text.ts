// Desktop words for the attachment refusals, kept beside the other failure pieces' translations.

import { translate } from '@/i18n/i18n'
import {
  AGENT_SESSION_FAILURE_COPY as COPY,
  type AgentSessionFailureCopyId,
  type AgentSessionFailureCopyValues
} from '../../../../shared/agent-session-failure-copy'

export const ATTACHMENT_FAILURE_PIECES = {
  attachmentEmpty: () =>
    translate('components.native-chat.failureWords.attachmentEmpty', COPY.attachmentEmpty),
  attachmentTooLarge: () =>
    translate('components.native-chat.failureWords.attachmentTooLarge', COPY.attachmentTooLarge),
  attachmentLargerThan: (values) =>
    translate(
      'components.native-chat.failureWords.attachmentLargerThan',
      COPY.attachmentLargerThan,
      values
    ),
  attachmentTooMany: () =>
    translate('components.native-chat.failureWords.attachmentTooMany', COPY.attachmentTooMany),
  attachmentAtMost: (values) =>
    translate(
      'components.native-chat.failureWords.attachmentAtMost',
      COPY.attachmentAtMost,
      values
    ),
  attachmentTotalTooLarge: () =>
    translate(
      'components.native-chat.failureWords.attachmentTotalTooLarge',
      COPY.attachmentTotalTooLarge
    ),
  attachmentTotalMoreThan: (values) =>
    translate(
      'components.native-chat.failureWords.attachmentTotalMoreThan',
      COPY.attachmentTotalMoreThan,
      values
    ),
  attachmentUnsupportedType: (values) =>
    translate(
      'components.native-chat.failureWords.attachmentUnsupportedType',
      COPY.attachmentUnsupportedType,
      values
    ),
  attachmentNotAFile: () =>
    translate('components.native-chat.failureWords.attachmentNotAFile', COPY.attachmentNotAFile),
  attachmentNoSource: () =>
    translate('components.native-chat.failureWords.attachmentNoSource', COPY.attachmentNoSource),
  attachmentInvalid: () =>
    translate('components.native-chat.failureWords.attachmentInvalid', COPY.attachmentInvalid),
  attachmentUnreadable: () =>
    translate('components.native-chat.failureWords.attachmentUnreadable', COPY.attachmentUnreadable)
} satisfies Partial<
  Record<AgentSessionFailureCopyId, (values: AgentSessionFailureCopyValues) => string>
>

import { translate } from '@/i18n/i18n'
import {
  AGENT_SESSION_FAILURE_COPY as COPY,
  type AgentSessionFailureCopyId,
  type AgentSessionFailureCopyValues
} from '../../../../shared/agent-session/failures/agent-session-failure-copy'

export const ATTACHMENT_FAILURE_PIECES = {
  attachmentEmpty: () =>
    translate('components.native-chat.failureWords.attachmentEmpty', COPY.attachmentEmpty),
  attachmentItemEmpty: (values) =>
    translate(
      'components.native-chat.failureWords.attachmentItemEmpty',
      COPY.attachmentItemEmpty,
      values
    ),
  attachmentTooLarge: () =>
    translate('components.native-chat.failureWords.attachmentTooLarge', COPY.attachmentTooLarge),
  attachmentItemTooLarge: (values) =>
    translate(
      'components.native-chat.failureWords.attachmentItemTooLarge',
      COPY.attachmentItemTooLarge,
      values
    ),
  attachmentLargerThan: (values) =>
    translate(
      'components.native-chat.failureWords.attachmentLargerThan',
      COPY.attachmentLargerThan,
      values
    ),
  attachmentItemLargerThan: (values) =>
    translate(
      'components.native-chat.failureWords.attachmentItemLargerThan',
      COPY.attachmentItemLargerThan,
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
  attachmentItemUnsupportedType: (values) =>
    translate(
      'components.native-chat.failureWords.attachmentItemUnsupportedType',
      COPY.attachmentItemUnsupportedType,
      values
    ),
  attachmentNotAFile: () =>
    translate('components.native-chat.failureWords.attachmentNotAFile', COPY.attachmentNotAFile),
  attachmentItemNotAFile: (values) =>
    translate(
      'components.native-chat.failureWords.attachmentItemNotAFile',
      COPY.attachmentItemNotAFile,
      values
    ),
  attachmentNoSource: () =>
    translate('components.native-chat.failureWords.attachmentNoSource', COPY.attachmentNoSource),
  attachmentInvalid: () =>
    translate('components.native-chat.failureWords.attachmentInvalid', COPY.attachmentInvalid),
  attachmentUnreadable: () =>
    translate('components.native-chat.failureWords.attachmentUnreadable', COPY.attachmentUnreadable)
} satisfies Partial<
  Record<AgentSessionFailureCopyId, (values: AgentSessionFailureCopyValues) => string>
>

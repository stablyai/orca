// Translate shared roster phrases whole with shared English fallbacks to keep desktop/mobile wording aligned.

import { translate } from '@/i18n/i18n'
import {
  NATIVE_CHAT_SUBAGENT_GROUP_COPY as COPY,
  type NativeChatSubagentGroupCopyId,
  type NativeChatSubagentGroupSay
} from '../../../../shared/native-chat/transcript/native-chat-subagent-group-header'
import type { CopyValues } from '../../../../shared/counted-copy-english'

const PIECES: Record<NativeChatSubagentGroupCopyId, (values?: CopyValues) => string> = {
  stateCompleted: () =>
    translate('components.native-chat.subagents.state.completed', COPY.stateCompleted),
  stateWorking: () =>
    translate('components.native-chat.subagents.state.working', COPY.stateWorking),
  stateIdle: () => translate('components.native-chat.subagents.state.idle', COPY.stateIdle),
  stateFailed: () => translate('components.native-chat.subagents.state.failed', COPY.stateFailed),
  stateStopped: () =>
    translate('components.native-chat.subagents.state.stopped', COPY.stateStopped),
  stateUnverifiable: () =>
    translate('components.native-chat.subagents.state.unverifiable', COPY.stateUnverifiable),
  stateWorkingCount: (values) =>
    translate('components.native-chat.subagents.state.workingCount', COPY.stateWorkingCount.other, {
      ...values,
      count: values?.count,
      defaultValue_one: COPY.stateWorkingCount.one
    }),
  stateIdleCount: (values) =>
    translate('components.native-chat.subagents.state.idleCount', COPY.stateIdleCount.other, {
      ...values,
      count: values?.count,
      defaultValue_one: COPY.stateIdleCount.one
    }),
  stateFailedCount: (values) =>
    translate('components.native-chat.subagents.state.failedCount', COPY.stateFailedCount.other, {
      ...values,
      count: values?.count,
      defaultValue_one: COPY.stateFailedCount.one
    }),
  stateStoppedCount: (values) =>
    translate('components.native-chat.subagents.state.stoppedCount', COPY.stateStoppedCount.other, {
      ...values,
      count: values?.count,
      defaultValue_one: COPY.stateStoppedCount.one
    }),
  stateUnverifiableCount: (values) =>
    translate(
      'components.native-chat.subagents.state.unverifiableCount',
      COPY.stateUnverifiableCount.other,
      { ...values, count: values?.count, defaultValue_one: COPY.stateUnverifiableCount.one }
    ),
  started: (values) =>
    translate('components.native-chat.subagents.started', COPY.started.other, {
      ...values,
      count: values?.count,
      defaultValue_one: COPY.started.one
    }),
  ran: (values) =>
    translate('components.native-chat.subagents.ran', COPY.ran.other, {
      ...values,
      count: values?.count,
      defaultValue_one: COPY.ran.one
    }),
  tokens: (values) => translate('components.native-chat.subagents.tokens', COPY.tokens, values)
}

export const sayNativeChatSubagentGroupTranslated: NativeChatSubagentGroupSay = (id, values) =>
  PIECES[id](values)

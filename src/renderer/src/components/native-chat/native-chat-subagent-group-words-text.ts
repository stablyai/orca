// Desktop words for a transcript roster row: each shared piece translated whole, with the shared
// English as its fallback, so desktop and the phone never word one spawn group differently.

import { translate } from '@/i18n/i18n'
import {
  NATIVE_CHAT_SUBAGENT_GROUP_COPY as COPY,
  type NativeChatSubagentGroupCopyId,
  type NativeChatSubagentGroupSay
} from '../../../../shared/native-chat-subagent-group-header'

const PIECES: Record<
  NativeChatSubagentGroupCopyId,
  (values?: { value0: string | number }) => string
> = {
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
    translate(
      'components.native-chat.subagents.state.workingCount',
      COPY.stateWorkingCount,
      values
    ),
  stateIdleCount: (values) =>
    translate('components.native-chat.subagents.state.idleCount', COPY.stateIdleCount, values),
  stateFailedCount: (values) =>
    translate('components.native-chat.subagents.state.failedCount', COPY.stateFailedCount, values),
  stateStoppedCount: (values) =>
    translate(
      'components.native-chat.subagents.state.stoppedCount',
      COPY.stateStoppedCount,
      values
    ),
  stateUnverifiableCount: (values) =>
    translate(
      'components.native-chat.subagents.state.unverifiableCount',
      COPY.stateUnverifiableCount,
      values
    ),
  startedOne: () => translate('components.native-chat.subagents.startedOne', COPY.startedOne),
  startedN: (values) =>
    translate('components.native-chat.subagents.startedN', COPY.startedN, values),
  ranOne: () => translate('components.native-chat.subagents.ranOne', COPY.ranOne),
  ranN: (values) => translate('components.native-chat.subagents.ranN', COPY.ranN, values),
  tokens: (values) => translate('components.native-chat.subagents.tokens', COPY.tokens, values)
}

export const sayNativeChatSubagentGroupTranslated: NativeChatSubagentGroupSay = (id, values) =>
  PIECES[id](values)

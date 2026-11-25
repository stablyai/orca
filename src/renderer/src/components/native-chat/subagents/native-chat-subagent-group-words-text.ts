// Translate shared roster phrases whole with shared English fallbacks to keep desktop/mobile wording aligned.

import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  NATIVE_CHAT_SUBAGENT_GROUP_COPY as COPY,
  type NativeChatSubagentGroupCopyId,
  type NativeChatSubagentGroupSay
} from '../../../../../shared/native-chat/transcript/subagents/native-chat-subagent-group-header'
import type { CopyValues } from '../../../../../shared/i18n/counted-copy-english'
import type { NativeChatSubagentState } from '../../../../../shared/native-chat/native-chat-types'

function pieces(
  t: Translate
): Record<NativeChatSubagentGroupCopyId, (values?: CopyValues) => string> {
  return {
    stateCompleted: () =>
      t('components.native-chat.subagents.state.completed', COPY.stateCompleted),
    stateWorking: () => t('components.native-chat.subagents.state.working', COPY.stateWorking),
    stateIdle: () => t('components.native-chat.subagents.state.idle', COPY.stateIdle),
    stateFailed: () => t('components.native-chat.subagents.state.failed', COPY.stateFailed),
    stateStopped: () => t('components.native-chat.subagents.state.stopped', COPY.stateStopped),
    stateUnverifiable: () =>
      t('components.native-chat.subagents.state.unverifiable', COPY.stateUnverifiable),
    stateWorkingCount: (values) =>
      t('components.native-chat.subagents.state.workingCount', COPY.stateWorkingCount.other, {
        ...values,
        count: values?.count,
        defaultValue_one: COPY.stateWorkingCount.one
      }),
    stateIdleCount: (values) =>
      t('components.native-chat.subagents.state.idleCount', COPY.stateIdleCount.other, {
        ...values,
        count: values?.count,
        defaultValue_one: COPY.stateIdleCount.one
      }),
    stateFailedCount: (values) =>
      t('components.native-chat.subagents.state.failedCount', COPY.stateFailedCount.other, {
        ...values,
        count: values?.count,
        defaultValue_one: COPY.stateFailedCount.one
      }),
    stateStoppedCount: (values) =>
      t('components.native-chat.subagents.state.stoppedCount', COPY.stateStoppedCount.other, {
        ...values,
        count: values?.count,
        defaultValue_one: COPY.stateStoppedCount.one
      }),
    stateUnverifiableCount: (values) =>
      t(
        'components.native-chat.subagents.state.unverifiableCount',
        COPY.stateUnverifiableCount.other,
        { ...values, count: values?.count, defaultValue_one: COPY.stateUnverifiableCount.one }
      ),
    started: (values) =>
      t('components.native-chat.subagents.started', COPY.started.other, {
        ...values,
        count: values?.count,
        defaultValue_one: COPY.started.one
      }),
    ran: (values) =>
      t('components.native-chat.subagents.ran', COPY.ran.other, {
        ...values,
        count: values?.count,
        defaultValue_one: COPY.ran.one
      }),
    tokens: (values) => t('components.native-chat.subagents.tokens', COPY.tokens, values)
  }
}

/** Pass the caller's `t`, which changes with the UI language and its catalogs, so memoized words follow them. */
export function sayNativeChatSubagentGroupWith(t: Translate): NativeChatSubagentGroupSay {
  const words = pieces(t)
  return (id, values) => words[id](values)
}

export const sayNativeChatSubagentGroupTranslated = sayNativeChatSubagentGroupWith(translate)

/** A single subagent's state where it leads a line: "Completed · 7s". */
export function sayNativeChatSubagentStateHeading(state: NativeChatSubagentState): string {
  switch (state) {
    case 'completed':
      return translate('components.native-chat.subagents.stateHeading.completed', 'Completed')
    case 'working':
      return translate('components.native-chat.subagents.stateHeading.working', 'Working')
    case 'idle':
      return translate('components.native-chat.subagents.stateHeading.idle', 'Idle')
    case 'failed':
      return translate('components.native-chat.subagents.stateHeading.failed', 'Failed')
    case 'stopped':
      return translate('components.native-chat.subagents.stateHeading.stopped', 'Stopped')
    case 'unverifiable':
      return translate(
        'components.native-chat.subagents.stateHeading.unverifiable',
        'Status unavailable'
      )
  }
}

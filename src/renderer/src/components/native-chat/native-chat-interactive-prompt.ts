import { translate } from '@/i18n/i18n'
import {
  NATIVE_CHAT_APPROVAL_COPY as COPY,
  type NativeChatApprovalSay
} from '../../../../shared/native-chat-interactive-prompt'

export {
  buildAskAnswerKeys,
  buildCodexAskAnswerKeys,
  formatAskAnswer,
  hasAskAnswer,
  parseAskFromStatus,
  registerQuestionTool,
  type AskAnswerKeyGroup,
  type AskAnswerSelection,
  type AskOption,
  type AskPrompt,
  type AskQuestion,
  type InteractiveQuestionParser
} from '../../../../shared/native-chat-ask'
export {
  chatApprovalFromJournal,
  type ChatApproval,
  type InteractivePromptCard
} from '../../../../shared/native-chat-interactive-prompt'

const PIECES: Record<keyof typeof COPY, (values?: { value0: string }) => string> = {
  title: (values) => translate('components.native-chat.approval.title', COPY.title, values),
  allow: () => translate('components.native-chat.approval.allow', COPY.allow),
  deny: () => translate('components.native-chat.approval.deny', COPY.deny),
  planReviewTitle: () =>
    translate('components.native-chat.approval.plan.reviewTitle', COPY.planReviewTitle),
  planRefineHint: () =>
    translate('components.native-chat.approval.plan.refineHint', COPY.planRefineHint)
}

export const sayNativeChatApprovalTranslated: NativeChatApprovalSay = (id, values) =>
  PIECES[id](values)

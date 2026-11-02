// @protected-copy: agent Allow/Deny approval prompt.
import { translate } from '@/i18n/i18n'
import {
  NATIVE_CHAT_APPROVAL_COPY as COPY,
  type NativeChatApprovalSay
} from '../../../../shared/native-chat-interactive-prompt'

const PIECES: Record<keyof typeof COPY, (values?: { value0: string }) => string> = {
  title: (values) => translate('components.native-chat.approval.title', COPY.title, values),
  allow: () => translate('components.native-chat.approval.allow', COPY.allow),
  deny: () => translate('components.native-chat.approval.deny', COPY.deny),
  planReviewTitle: () =>
    translate('components.native-chat.approval.plan.reviewTitle', COPY.planReviewTitle),
  planRefineHint: () =>
    translate('components.native-chat.approval.plan.refineHint', COPY.planRefineHint),
  folderTrustTitle: () =>
    translate('components.native-chat.approval.folderTrust.title', COPY.folderTrustTitle),
  folderTrustHint: () =>
    translate('components.native-chat.approval.folderTrust.hint', COPY.folderTrustHint),
  trustFolder: () =>
    translate('components.native-chat.approval.folderTrust.trust', COPY.trustFolder),
  exit: () => translate('components.native-chat.approval.folderTrust.exit', COPY.exit),
  startupMenuTitle: (values) =>
    translate('components.native-chat.approval.startupMenu.title', COPY.startupMenuTitle, values)
}

export const sayNativeChatApprovalTranslated: NativeChatApprovalSay = (id, values) =>
  PIECES[id](values)

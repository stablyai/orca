import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import {
  openNativeChatAuxiliary,
  useNativeChatAuxiliaryAvailable,
  useNativeChatAuxiliaryReferenceBlockedReason,
  type NativeChatAuxiliaryParent
} from '@/components/right-sidebar/side-chat/native-chat-auxiliary-chat'
import type { NativeChatAuxiliaryChat } from './native-chat-context-menu-target'
import type { NativeChatStructuredComposerTransport } from '../../composer/submit/native-chat-structured-composer-transport'
import type { NativeChatStructuredViewProps } from '../../native-chat-view-types'

export function useNativeChatPaneAuxiliaryActions(
  {
    sessionId,
    tabId,
    target,
    agent,
    groupId
  }: Pick<NativeChatStructuredViewProps, 'sessionId' | 'tabId' | 'target' | 'agent' | 'groupId'>,
  worktreeId: string | null,
  composerAccessible: boolean
): {
  selection: NativeChatAuxiliaryChat | undefined
  commands: NativeChatStructuredComposerTransport['sideChat']
} {
  const t = useTranslate()
  const parent: NativeChatAuxiliaryParent | null =
    worktreeId && groupId && agent === 'omp'
      ? { sessionId, tabId, target, agent, worktreeId }
      : null
  const available = useNativeChatAuxiliaryAvailable(parent)
  const childBlocked = useNativeChatAuxiliaryReferenceBlockedReason(available ? parent : null)
  if (!parent || !available) {
    return { selection: undefined, commands: undefined }
  }
  const referenceBlockedReason = composerAccessible
    ? childBlocked
    : t(
        'components.native-chat.auxiliaryChat.referenceBlocked',
        'Return to this chat’s composer before adding a selection.'
      )
  return {
    selection: {
      referenceBlockedReason,
      addReference: (reference) => {
        if (referenceBlockedReason === null) {
          void openNativeChatAuxiliary({ parent, reference }).then((result) => {
            if ('refused' in result) {
              toast.error(result.refused)
            }
          })
        }
      }
    },
    commands: {
      auxiliary: true,
      notReadyReason: null,
      open: (question) => openNativeChatAuxiliary({ parent, question })
    }
  }
}

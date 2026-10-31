import { getAgentLabel } from '@/lib/agent-catalog'
import { formatAgentTypeLabel } from '../../../../shared/agent-type-label'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { MAX_SKILL_REFS } from '../../../../shared/rpc-contract/structured-agent-session-message-params'
import { SkillRefLimitError } from '../../../../shared/structured-agent-session-send-mutation'
import { promptSkillRefs } from './native-chat-prompt-document'
import { useCallback } from 'react'
import { completeNativeChatStructuredUserAction } from './native-chat-structured-user-action'
import {
  isStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionGoalCommand,
  structuredAgentSessionCommandChangesConversation
} from '../../../../shared/structured-agent-session-composer'
import type { AgentType } from '../../../../shared/agent-status-types'
import { dispatchNativeChatStructuredComposerText } from './native-chat-structured-composer-dispatch'
import type {
  NativeChatComposerSendIntent,
  NativeChatStructuredComposerTransport
} from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { nativeChatAttachImagesAgainReason } from './native-chat-image-reattach'
import { nativeChatNoticeFromError } from './native-chat-composer-notice'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import { translate } from '@/i18n/i18n'
import {
  readNativeChatComposerDraft,
  subscribeToNativeChatComposerDraftAppend,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { nativeChatComposerDraftLeftAfterSend } from './native-chat-composer-draft-comparison'
import {
  admitNativeChatPastedText,
  resolveNativeChatPastedText
} from './native-chat-composer-pasted-text-references'

export type UseNativeChatStructuredComposerSendArgs = {
  agent: AgentType
  draftScopeKey: string
  imageAttachments: readonly NativeChatComposerImageAttachment[]
  structuredTransport?: NativeChatStructuredComposerTransport
  isComposing: () => boolean
  clearSkillOrigin: () => void
  setDraft: (value: string) => void
  setCaret: (caret: number) => void
}

/** A command the host runs itself (and `/goal` where the host sets goals), never a message. */
function isNativeChatStructuredHostCommand(
  text: string,
  agent: AgentType,
  transport: NativeChatStructuredComposerTransport
): boolean {
  return (
    isStructuredAgentSessionComposerCommand(text, agent, transport.sessionCommands) ||
    (transport.threadGoal !== undefined && isStructuredAgentSessionGoalCommand(text))
  )
}

export type NativeChatStructuredComposerSend = (
  text: string,
  attachments?: readonly NativeChatComposerImageAttachment[],
  intent?: NativeChatComposerSendIntent
) => Promise<void>

/** Clear submitted composer content only after structured transport acceptance. */
export function useNativeChatStructuredComposerSend({
  agent,
  draftScopeKey,
  imageAttachments,
  structuredTransport,
  isComposing,
  clearSkillOrigin,
  setDraft,
  setCaret
}: UseNativeChatStructuredComposerSendArgs): NativeChatStructuredComposerSend {
  return useCallback<NativeChatStructuredComposerSend>(
    async (text, attachments = imageAttachments, intent): Promise<void> => {
      // Picked commands must also wait for pending attachments to acquire paths.
      if (!structuredTransport || attachments.some((attachment) => attachment.pending)) {
        return
      }
      if (!admitNativeChatPastedText(draftScopeKey, text, structuredTransport.onError)) {
        return
      }
      text = resolveNativeChatPastedText(draftScopeKey, text)
      const hostCommand = isNativeChatStructuredHostCommand(text, agent, structuredTransport)
      // Blocked hosts cannot take turns/conversation commands; option commands only configure later turns.
      if (
        structuredTransport.sendBlockedReason !== undefined &&
        (!hostCommand || structuredAgentSessionCommandChangesConversation(text))
      ) {
        return
      }
      // A command picked while images await re-attaching would send them without a file.
      const attachAgain = nativeChatAttachImagesAgainReason(attachments)
      if (attachAgain) {
        structuredTransport.onError(attachAgain)
        return
      }
      if (attachments.length > 0 && hostCommand) {
        structuredTransport.onError(
          translate(
            'components.native-chat.composer.commandAttachmentsUnsupported',
            'Remove attachments before using a chat-session command.'
          )
        )
        return
      }
      // A conversation command reveals at the press, not after its round trip; options move nothing.
      if (hostCommand && structuredAgentSessionCommandChangesConversation(text)) {
        structuredTransport.onSubmitted?.()
      }
      const isCurrent = structuredTransport.capturePresentation()
      const submitted = readNativeChatComposerDraft(draftScopeKey)
      let completeAddition = false
      const stopObservingAppend = subscribeToNativeChatComposerDraftAppend(
        draftScopeKey,
        (addition) => {
          if (typeof addition !== 'function' && addition.document !== undefined) {
            completeAddition = true
          }
        }
      )
      await dispatchNativeChatStructuredComposerText(
        structuredTransport,
        text,
        attachments,
        promptSkillRefs(submitted.document),
        intent
      )
        .then(({ accepted, error, refusedWhile, revealsTranscript }) => {
          if (!hostCommand || isCurrent()) {
            structuredTransport.onError(error, refusedWhile ? { refusedWhile } : undefined)
          }
          if (!accepted) {
            return
          }
          completeNativeChatStructuredUserAction(
            agent,
            structuredTransport,
            revealsTranscript && (!hostCommand || isCurrent())
          )
          // A round trip may outlast edits in any composer for this conversation; remove only the submitted content.
          const left = nativeChatComposerDraftLeftAfterSend(
            readNativeChatComposerDraft(draftScopeKey),
            submitted
          )
          if (!left) {
            return
          }
          if (completeAddition) {
            updateNativeChatComposerDraft(
              draftScopeKey,
              { ...left, document: left.document },
              'immediate'
            )
          }
          if (hostCommand && !isCurrent()) {
            if (!completeAddition) {
              updateNativeChatComposerDraft(
                draftScopeKey,
                { text: left.text, document: undefined, images: left.images },
                'immediate'
              )
            }
            return
          }
          updateNativeChatComposerDraft(draftScopeKey, { images: left.images }, 'immediate')
          // A live composition owns the field, which keeps only what it composed once cleared.
          const composing = isComposing()
          setDraft(composing ? '' : left.text)
          setCaret(composing ? 0 : left.text.length)
          clearSkillOrigin()
        })
        .catch((error) => {
          if (hostCommand && !isCurrent()) {
            return
          }
          const notice = nativeChatNoticeFromError(
            error,
            error instanceof SkillRefLimitError
              ? translate(
                  'components.native-chat.composer.tooManySkills',
                  'Your message was not sent to {{agent}}. Keep at most {{limit}} selected skill files and try again.',
                  {
                    agent: isTuiAgent(agent) ? getAgentLabel(agent) : formatAgentTypeLabel(agent),
                    limit: MAX_SKILL_REFS
                  }
                )
              : agentSessionWriteNoticeText([hostCommand ? 'notDoneCommand' : 'notDoneSend'])
          )
          structuredTransport.onError(notice.text, { errorText: notice.errorText })
        })
        .finally(stopObservingAppend)
    },
    [
      agent,
      clearSkillOrigin,
      draftScopeKey,
      imageAttachments,
      isComposing,
      setCaret,
      setDraft,
      structuredTransport
    ]
  )
}

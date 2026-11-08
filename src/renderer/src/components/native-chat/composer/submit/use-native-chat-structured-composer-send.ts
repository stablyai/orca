import { serializeNativeChatAgentReferences } from '../pickers/native-chat-agent-reference-send'
import {
  hasNativeChatStagedFiles,
  captureNativeChatStagedInput
} from '../../drafts/native-chat-draft-attachment-staging'
import { mayHoldAgentReferences } from '../../../../../../shared/orchestration/mailbox/orchestration-agent-reference'
import { getAgentLabel } from '@/lib/agent-catalog'
import { formatAgentTypeLabel } from '../../../../../../shared/agent-status/presentation/agent-type-label'
import { isTuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import { MAX_SKILL_REFS } from '../../../../../../shared/rpc-contract/structured-agent-session-message-params'
import { SkillRefLimitError } from '../../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import {
  promptHasInteractionModeSkill,
  promptSkillRefs
} from '../editor/native-chat-prompt-document'
import type { StructuredAgentSessionAttachmentPreparation } from '../../session/structured/delivery/structured-agent-session-send-slot'
import { useCallback } from 'react'
import { completeNativeChatStructuredUserAction } from './native-chat-structured-user-action'
import {
  isStructuredAgentSessionHostCommand,
  isStructuredAgentSessionGoalCommand,
  structuredAgentSessionCommandChangesConversation
} from '../../../../../../shared/agent-session/view/structured-agent-session-composer'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { dispatchNativeChatStructuredComposerText } from './native-chat-structured-composer-dispatch'
import type { NativeChatComposerSendIntent } from './native-chat-composer-send-intent'
import type { NativeChatStructuredComposerTransport } from './native-chat-structured-composer-transport'
import type { NativeChatComposerImageAttachment } from '../../attachments/chips/native-chat-image-attachment'
import { nativeChatAttachImagesAgainReason } from '../../attachments/chips/native-chat-image-reattach'
import { nativeChatNoticeFromError } from '../controls/native-chat-composer-notice'
import { agentSessionWriteNoticeText } from '../../messages/notices/agent-session-write-notice-text'
import { translate } from '@/i18n/i18n'
import {
  captureNativeChatComposerSubmission,
  subscribeToNativeChatComposerDraftAppend
} from '../../drafts/native-chat-composer-draft-memory'
import {
  finishNativeChatComposerSubmission,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import { nativeChatComposerDraftLeftAfterSend } from '../../drafts/native-chat-composer-draft-comparison'
import {
  admitNativeChatPastedText,
  projectNativeChatPastedText
} from '../../paste/native-chat-composer-pasted-text-references'

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

export type NativeChatStructuredComposerSend = (
  text: string,
  attachments?: readonly NativeChatComposerImageAttachment[],
  intent?: NativeChatComposerSendIntent
) => Promise<boolean>

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
    async (text, attachments = imageAttachments, intent): Promise<boolean> => {
      // Picked commands must also wait for pending attachments to acquire paths.
      if (!structuredTransport || attachments.some((attachment) => attachment.pending)) {
        return false
      }
      if (!admitNativeChatPastedText(draftScopeKey, text, structuredTransport.onError)) {
        return false
      }
      const submitted = readNativeChatComposerDraft(draftScopeKey)
      const submittedText = text
      text = projectNativeChatPastedText(text, submitted.pastedTextFiles)
      const pickedModeSkill = promptHasInteractionModeSkill(agent, text, submitted.document)
      const hostCommand =
        !pickedModeSkill &&
        isStructuredAgentSessionHostCommand(
          text,
          structuredTransport.threadGoal !== undefined,
          agent,
          structuredTransport.optionSnapshot
        )
      // Blocked hosts cannot take turns/conversation commands; option commands only configure later turns.
      if (
        structuredTransport.sendBlockedReason !== undefined &&
        (!hostCommand || structuredAgentSessionCommandChangesConversation(text))
      ) {
        return false
      }
      // A command picked while images await re-attaching would send them without a file.
      const attachAgain = nativeChatAttachImagesAgainReason(attachments)
      if (attachAgain) {
        structuredTransport.onError(attachAgain)
        return false
      }
      if (attachments.length > 0 && hostCommand) {
        structuredTransport.onError(
          translate(
            'components.native-chat.composer.commandAttachmentsUnsupported',
            'Remove attachments before using a chat-session command.'
          )
        )
        return false
      }
      // A conversation command reveals at the press, not after its round trip; options move nothing.
      if (hostCommand && structuredAgentSessionCommandChangesConversation(text)) {
        structuredTransport.onSubmitted?.()
      }
      const isCurrent = structuredTransport.capturePresentation()
      const revealAdmitted =
        structuredTransport.captureAdmittedReveal?.() ?? structuredTransport.onSubmitted
      if (
        mayHoldAgentReferences(submittedText) &&
        (!hostCommand ||
          (structuredTransport.threadGoal && isStructuredAgentSessionGoalCommand(text)))
      ) {
        text = serializeNativeChatAgentReferences(
          submittedText,
          submitted.document,
          submitted.pastedTextFiles,
          hostCommand ? 'goal' : 'message'
        )
      }
      const submission = captureNativeChatComposerSubmission(draftScopeKey)
      let consumed = false
      let completeAddition = false
      submission.stopObserving = subscribeToNativeChatComposerDraftAppend(
        draftScopeKey,
        (addition) => {
          if (typeof addition !== 'function' && addition.document !== undefined) {
            completeAddition = true
          }
        }
      )
      const stagedInput =
        !hostCommand &&
        !structuredTransport.attachmentStagingScope &&
        hasNativeChatStagedFiles(draftScopeKey)
          ? captureNativeChatStagedInput(draftScopeKey, { text, attachments })
          : undefined
      let transferred = false
      const consume = () => {
        // A round trip may outlast edits in any composer for this conversation; remove only the submitted content.
        const submitted = submission.draft
        if (!submitted || consumed) {
          return
        }
        consumed = true
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
      }
      const prepareAttachments: StructuredAgentSessionAttachmentPreparation | undefined =
        stagedInput ? (input) => stagedInput.prepare(input, structuredTransport) : undefined
      return dispatchNativeChatStructuredComposerText(
        structuredTransport,
        text,
        attachments,
        promptSkillRefs(submission.draft?.document),
        {
          ...intent,
          ...(prepareAttachments
            ? { prepareAttachments, onSettled: () => stagedInput?.release() }
            : {})
        },
        consume
      )
        .then(({ accepted, error, refusedWhile, revealsTranscript }) => {
          if (!hostCommand || isCurrent()) {
            structuredTransport.onError(error, refusedWhile ? { refusedWhile } : undefined)
          }
          if (!accepted) {
            finishNativeChatComposerSubmission(draftScopeKey, submission, consumed)
            return false
          }
          transferred = true
          completeNativeChatStructuredUserAction(
            agent,
            structuredTransport,
            revealsTranscript && (!hostCommand || isCurrent()) ? revealAdmitted : undefined
          )
          consume()
          return true
        })
        .catch((error) => {
          finishNativeChatComposerSubmission(draftScopeKey, submission, consumed)
          if (hostCommand && !isCurrent()) {
            return false
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
          return false
        })
        .finally(() => {
          if (!transferred) {
            stagedInput?.release()
          }
          finishNativeChatComposerSubmission(draftScopeKey, submission)
        })
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

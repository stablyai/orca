import { createNonSecureContextUuid as createUuidV4 } from '../../../../../shared/non-secure-context-uuid'
import { releaseBrowserAttachmentFiles } from '@/lib/browser-attachment-files'
import { stageNativeChatDraftFile } from '../drafts/native-chat-draft-attachment-staging'
import {
  nativeChatPastedTextLabel,
  nativeChatPastedTextOperations,
  nativeChatPastedTextToken
} from './native-chat-pasted-text-reference'

import { useCallback } from 'react'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { isNativeChatLongPaste } from '../../../../../shared/native-chat/input/native-chat-long-paste'
import { structuredAgentSessionBlocksTooLarge } from '../../../../../shared/rpc-contract/structured-agent-session-message-params'
import { structuredAgentSessionSendBody } from '../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { imageReferencesToPromptMarkers } from '../../../../../shared/native-chat/transcript/native-chat-image-transcript-markers'
import {
  nativeChatAttachFailedNotice,
  nativeChatAttachmentOwnerChangedNotice
} from '../attachments/intake/native-chat-attachment-notices'
import { cachedNativeChatPasteUploadTarget } from '../attachments/uploads/native-chat-session-attachment-upload'
import type { NativeChatAttachmentOwner } from '../attachments/uploads/native-chat-attachment-owner'
import { nativeChatAttachmentOwnerUnchanged } from '../attachments/uploads/native-chat-resolved-path-ownership'
import type { NativeChatComposerInput } from '../composer/editor/native-chat-composer-input'
import { readNativeChatComposerDraft } from '../drafts/native-chat-composer-draft-store'
import { nativeChatImageRowIds } from '../composer/editor/native-chat-composer-image-references'
import {
  resolveNativeChatPastedText,
  settleNativeChatPastedText
} from './native-chat-composer-pasted-text-references'

function pastedTextTooLargeNotice(): string {
  return translate(
    'components.native-chat.composer.pastedTextTooLarge',
    'This paste would put your message over the 256 KB limit for one message. Shorten it, then paste again.'
  )
}

function nativeChatDraftTooLarge(scopeKey: string, text: string): boolean {
  const prompt = imageReferencesToPromptMarkers(
    resolveNativeChatPastedText(scopeKey, text),
    nativeChatImageRowIds(scopeKey)
  )
  const images = readNativeChatComposerDraft(scopeKey).images
  const body = structuredAgentSessionSendBody(
    prompt,
    images.map(({ path }) => ({ path, previewUri: '' }))
  )
  return structuredAgentSessionBlocksTooLarge(body.blocks)
}

export function useNativeChatPastedTextFile(args: {
  scopeKey: string
  /** Null: not a structured chat. Else the editor while it shows this scope. */
  scopeEditor: (() => NativeChatComposerInput | null) | null
  resolveAttachmentOwner: () => NativeChatAttachmentOwner
  insertTypedText: (text: string) => boolean
  setNotice: (notice: string | null, errorText?: string) => void
}): (text: string) => boolean {
  const { scopeKey, scopeEditor, resolveAttachmentOwner, insertTypedText, setNotice } = args
  return useCallback(
    (text: string): boolean => {
      const input = scopeEditor?.()
      if (!scopeEditor || !input?.stagePastedText || input.disabled) {
        return insertTypedText(text)
      }
      const { value, selectionStart, selectionEnd } = input
      const tooLarge = nativeChatDraftTooLarge(
        scopeKey,
        `${value.slice(0, selectionStart ?? 0)}${text}${value.slice(selectionEnd ?? 0)}`
      )
      const long = isNativeChatLongPaste(text)
      const owner = resolveAttachmentOwner()
      const target =
        owner.kind === 'runtime-session' ? cachedNativeChatPasteUploadTarget(owner) : null
      const canAttach = owner.kind === 'local' || target !== null
      if (!tooLarge && (!long || !canAttach)) {
        return insertTypedText(text)
      }
      if (!canAttach) {
        setNotice(pastedTextTooLargeNotice())
        return true
      }
      input.focus()
      const id = createUuidV4()
      nativeChatPastedTextOperations.set(id, { scopeKey, text })
      input.stagePastedText(nativeChatPastedTextToken(id))
      const fail = (notice: string) => {
        if (settleNativeChatPastedText(id)) {
          setNotice(notice)
        }
      }
      void window.api.ui
        .savePastedTextAsFile({
          text,
          ...(target
            ? { runtimeEnvironmentId: target.environmentId, agentSessionAttachment: target }
            : {})
        })
        .then(
          (path) => {
            const destinationScope = nativeChatPastedTextOperations.get(id)?.scopeKey
            if (nativeChatAttachmentOwnerUnchanged(owner, resolveAttachmentOwner())) {
              const retained = settleNativeChatPastedText(id, path)
              if (owner.kind === 'local' && owner.stagingScope) {
                if (retained && destinationScope) {
                  stageNativeChatDraftFile(destinationScope, path)
                } else {
                  releaseBrowserAttachmentFiles([path])
                }
              }
            } else {
              releaseBrowserAttachmentFiles([path])
              fail(nativeChatAttachmentOwnerChangedNotice())
            }
          },
          (error) =>
            fail(
              nativeChatAttachFailedNotice(
                [nativeChatPastedTextLabel()],
                extractIpcErrorMessage(error, '')
              )
            )
        )
      return true
    },
    [insertTypedText, resolveAttachmentOwner, scopeEditor, scopeKey, setNotice]
  )
}

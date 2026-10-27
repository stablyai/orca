import { createUuidV4 } from '../../../../shared/uuid-v4'
import {
  nativeChatPastedTextLabel,
  nativeChatPastedTextOperations,
  nativeChatPastedTextToken
} from './native-chat-pasted-text-reference'

import { useCallback } from 'react'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { isUtf8ByteLengthWithinLimit } from '../../../../shared/utf8-byte-limits'
import { structuredAgentSessionBlocksTooLarge } from '../../../../shared/rpc-contract/structured-agent-session-message-params'
import { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-send-mutation'
import { imageReferencesToPromptMarkers } from '../../../../shared/native-chat-image-transcript-markers'
import {
  nativeChatAttachFailedNotice,
  nativeChatAttachmentOwnerChangedNotice,
  cachedNativeChatPasteUploadTarget,
  nativeChatPasteUploadHostUnverified,
  type NativeChatAttachmentOwner
} from './native-chat-attachment-upload'
import { nativeChatAttachmentOwnerUnchanged } from './native-chat-resolved-path-ownership'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { readNativeChatComposerDraft } from './native-chat-composer-draft-store'
import { nativeChatImageRowIds } from './native-chat-composer-image-references'
import {
  nativeChatInlinePasteNotice,
  nativeChatInlinePasteProblem
} from './native-chat-inline-paste-limits'
import {
  resolveNativeChatPastedText,
  settleNativeChatPastedText
} from './native-chat-composer-pasted-text-references'

export const NATIVE_CHAT_PASTED_TEXT_FILE_THRESHOLD = 32 * 1024

function pastedTextTooLargeNotice(): string {
  return translate(
    'components.native-chat.composer.pastedTextTooLarge',
    'This paste would put your message over the 256 KB limit for one message. Shorten it, then paste again.'
  )
}

function pasteHostConnectingNotice(): string {
  return translate(
    'components.native-chat.composer.pasteHostConnecting',
    'Orca is still connecting to this server. Try pasting again in a moment.'
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

function stagePastedTextFile(args: {
  scopeKey: string
  input: NativeChatComposerInput
  text: string
  owner: NativeChatAttachmentOwner
  target: ReturnType<typeof cachedNativeChatPasteUploadTarget>
  resolveAttachmentOwner: () => NativeChatAttachmentOwner
  setNotice: (notice: string | null, errorText?: string) => void
}): void {
  const { scopeKey, input, text, owner, target, resolveAttachmentOwner, setNotice } = args
  input.focus()
  const id = createUuidV4()
  nativeChatPastedTextOperations.set(id, { scopeKey, text })
  input.stagePastedText?.(nativeChatPastedTextToken(id))
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
        if (nativeChatAttachmentOwnerUnchanged(owner, resolveAttachmentOwner())) {
          settleNativeChatPastedText(id, path)
        } else {
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
}

export function useNativeChatPastedTextFile(args: {
  scopeKey: string
  pastesInline?: () => boolean
  editor: () => NativeChatComposerInput | null
  filePastes: boolean
  resolveAttachmentOwner: () => NativeChatAttachmentOwner
  insertTypedText: (text: string) => boolean
  setNotice: (notice: string | null, errorText?: string) => void
}): (text: string) => boolean {
  const { scopeKey, editor, filePastes, resolveAttachmentOwner, insertTypedText, setNotice } = args
  const { pastesInline } = args
  return useCallback(
    (text: string): boolean => {
      const input = editor()
      if (!input || input.disabled) {
        return insertTypedText(text)
      }
      const { value, selectionStart, selectionEnd } = input
      const before = value.slice(0, selectionStart ?? 0)
      const after = value.slice(selectionEnd ?? 0)
      const draftWith = () => `${before}${text}${after}`
      const usesFiles = !pastesInline?.() && filePastes && Boolean(input.stagePastedText)
      let hostUnverified = false
      if (usesFiles) {
        const owner = resolveAttachmentOwner()
        const target =
          owner.kind === 'runtime-session' ? cachedNativeChatPasteUploadTarget(owner) : null
        hostUnverified =
          owner.kind === 'runtime-session' && nativeChatPasteUploadHostUnverified(owner)
        // Why: a file costs the editor nothing, so every paste it could not build inline becomes one.
        const long =
          text.length >= NATIVE_CHAT_PASTED_TEXT_FILE_THRESHOLD ||
          !isUtf8ByteLengthWithinLimit(text, NATIVE_CHAT_PASTED_TEXT_FILE_THRESHOLD - 1) ||
          nativeChatInlinePasteProblem(text) !== null
        if (
          (owner.kind === 'local' || target !== null) &&
          (long || nativeChatDraftTooLarge(scopeKey, draftWith()))
        ) {
          stagePastedTextFile({
            scopeKey,
            input,
            text,
            owner,
            target,
            resolveAttachmentOwner,
            setNotice
          })
          return true
        }
      }
      // Why: without a file the text is built into the editor whole, and a long line makes that stall.
      const problem = nativeChatInlinePasteProblem(text)
      if (problem) {
        setNotice(
          hostUnverified ? pasteHostConnectingNotice() : nativeChatInlinePasteNotice(problem)
        )
        return true
      }
      if (usesFiles && nativeChatDraftTooLarge(scopeKey, draftWith())) {
        setNotice(pastedTextTooLargeNotice())
        return true
      }
      return insertTypedText(text)
    },
    [editor, filePastes, insertTypedText, pastesInline, resolveAttachmentOwner, scopeKey, setNotice]
  )
}

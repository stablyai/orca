import { useCallback, useImperativeHandle, type ForwardedRef } from 'react'
import type { ClipboardEventLike } from '../../paste/native-chat-clipboard-payload'
import type { NativeChatComposerHandle } from '../native-chat-composer-types'
import { useNativeChatComposerPaste } from '../../paste/use-native-chat-composer-paste'
import type { UseNativeChatComposerPasteArgs } from '../../paste/native-chat-composer-paste-options'
import { useNativeChatTypedInsertion } from './use-native-chat-typed-insertion'
import { useNativeChatPastedTextFile } from '../../paste/use-native-chat-pasted-text-file'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { glowNativeChatComposer } from '../../native-chat-composer-glow'

type UseNativeChatComposerHandleArgs = Parameters<typeof useNativeChatTypedInsertion>[0] &
  Omit<UseNativeChatComposerPasteArgs, 'insertTypedText' | 'targetKey'> & {
    targetKey?: string
    target?: {
      paneKey: string
      targetPtyId: string | null
      structuredTransport?: {
        sessionId?: string
        worktreeId?: string
        runtimeEnvironmentId?: string | null
      }
    }
    /** Intake only: captured with the paste action, never consulted during settlement. */
    resend?: NativeChatComposerHandle['resend']
    /** A structured chat's editor while it shows this scope, where a long paste saved as a file lands. */
    pastedTextEditor: (() => NativeChatComposerInput | null) | null
    /** Text this long pastes as a "Pasted text" file; defaults to chat's. */
    longPasteThreshold?: number
    /** Opens the bot chat project/workspace target picker when available. */
    openWorkTargetPicker?: () => boolean
  }

function resolveTargetKey(args: UseNativeChatComposerHandleArgs): string {
  if (args.targetKey !== undefined) {
    return args.targetKey
  }
  const { paneKey, targetPtyId, structuredTransport } = args.target!
  return JSON.stringify([
    paneKey,
    targetPtyId,
    structuredTransport?.sessionId,
    structuredTransport?.worktreeId,
    structuredTransport?.runtimeEnvironmentId
  ])
}

/** Expose typed/pasted insertion to pane routing and return the paste handler. */
export function useNativeChatComposerHandle(
  ref: ForwardedRef<NativeChatComposerHandle>,
  args: UseNativeChatComposerHandleArgs
): (event: ClipboardEventLike) => void {
  const {
    textareaRef,
    isComposing,
    setDraft,
    setActiveSuggestion,
    target: _target,
    openWorkTargetPicker,
    ...restPasteArgs
  } = args
  const pasteArgs = { ...restPasteArgs, targetKey: resolveTargetKey(args) }
  const {
    insertTypedText,
    appendText: appendPlainText,
    acceptsText,
    insertPastedText,
    focus: focusInput,
    contains
  } = useNativeChatTypedInsertion({
    textareaRef,
    isComposing,
    setDraft,
    setCaret: args.setCaret,
    setActiveSuggestion
  })

  const { attachmentScopeKey } = args
  const appendText = useCallback(
    (text: string, options?: { glow?: boolean }): void => {
      appendPlainText(text)
      if (options?.glow && attachmentScopeKey) {
        glowNativeChatComposer(attachmentScopeKey)
      }
    },
    [appendPlainText, attachmentScopeKey]
  )

  const focus = useCallback(
    (options?: { caretAtEnd?: boolean; glow?: boolean }): boolean => {
      const focused = focusInput(options)
      if (focused && options?.glow && attachmentScopeKey) {
        glowNativeChatComposer(attachmentScopeKey)
      }
      return focused
    },
    [focusInput, attachmentScopeKey]
  )

  const insertPastedTextOrFile = useNativeChatPastedTextFile({
    scopeKey: args.attachmentScopeKey ?? '',
    // Without a draft scope there is no draft for a pending paste to settle in.
    scopeEditor: args.attachmentScopeKey ? args.pastedTextEditor : null,
    resolveAttachmentOwner: args.resolveAttachmentOwner,
    insertTypedText: insertPastedText,
    setNotice: args.setNotice,
    longPasteThreshold: args.longPasteThreshold
  })
  const { handlePaste: handlePasteEvent, pasteFromClipboard } = useNativeChatComposerPaste({
    ...pasteArgs,
    insertTypedText: insertPastedTextOrFile
  })

  useImperativeHandle(
    ref,
    () => ({
      insertAgentReferences: (references) => {
        const input = textareaRef.current
        if (!input || input.disabled || !input.insertAgentReferences || isComposing()) {
          return false
        }
        input.insertAgentReferences(references)
        input.focus()
        return true
      },
      isComposing,
      focus,
      resend: args.resend,
      insertTypedText,
      insertPastedText: insertPastedTextOrFile,
      acceptsText,
      appendText,
      handlePasteEvent,
      pasteFromClipboard,
      contains,
      ...(openWorkTargetPicker
        ? { openWorkTargetPicker: () => !isComposing() && openWorkTargetPicker() }
        : {})
    }),
    [
      textareaRef,
      isComposing,
      focus,
      args.resend,
      insertTypedText,
      insertPastedTextOrFile,
      acceptsText,
      appendText,
      handlePasteEvent,
      pasteFromClipboard,
      contains,
      openWorkTargetPicker
    ]
  )
  return handlePasteEvent
}

import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../store'
import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import {
  sendNativeChatMessage,
  sendNativeChatMessageWithImageAttachments,
  submitNativeChatPrompt
} from './native-chat-runtime-send'
import type { NativeChatSendHandle } from './native-chat-runtime-send'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import {
  applyMentionSuggestion,
  EMPTY_HISTORY,
  pushHistory,
  type HistoryState
} from './native-chat-composer-state'
import { readNativeChatDraftCache } from './native-chat-draft-cache'
import { useNativeChatDraft } from './use-native-chat-draft'
import { NativeChatComposerField } from './NativeChatComposerField'
import {
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import { useNativeChatComposerAttachments } from './use-native-chat-composer-attachments'
import { useNativeChatComposerPaste } from './use-native-chat-composer-paste'
import { useNativeChatExternalAttachments } from './use-native-chat-external-attachments'
import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'
import { useNativeChatSendLifecycle } from './use-native-chat-send-lifecycle'
import { useNativeChatSessionOptions } from './use-native-chat-session-options'
import { useNativeChatFileAttachmentActions } from './use-native-chat-file-attachment-actions'
import { useNativeChatDictationActions } from './use-native-chat-dictation-actions'
import { useNativeChatSessionOptionCommand } from './use-native-chat-session-option-command'
import { useNativeChatPickerState } from './use-native-chat-picker-state'
import { useNativeChatPickerCommandDispatch } from './use-native-chat-picker-command-dispatch'
import { useNativeChatTypedInsertion } from './use-native-chat-typed-insertion'
import type {
  NativeChatComposerHandle,
  NativeChatComposerProps
} from './native-chat-composer-types'

export type {
  NativeChatComposerHandle,
  NativeChatComposerProps
} from './native-chat-composer-types'

// Why: a plain ESC byte is what the agent TUIs read as the interrupt key over a
// PTY (matching how xterm forwards Escape). The richer interrupt-intent
// inference (agent-interrupt-intent.ts) is driven by the existing PTY input
// observers, so writing ESC through the same send path feeds that machinery.
const ESC = '\x1b'

/**
 * Rich native input for the chat view. Sends prompts into the running agent
 * through the same verified runtime path as typed input (KTD4), so the agent
 * cannot distinguish native input from keystrokes. Enter sends; Shift+Enter
 * inserts a newline; multi-line is bracketed-paste wrapped; Esc interrupts.
 * Slash-command and `@file` autocomplete are agent-aware; image paste persists a
 * temp file and injects the agent-appropriate path (or reports unsupported).
 */
export const NativeChatComposer = forwardRef<NativeChatComposerHandle, NativeChatComposerProps>(
  function NativeChatComposer(
    {
      terminalTabId,
      paneKey,
      targetPtyId,
      agent,
      canSend = true,
      isWorking = false,
      onStop,
      onOptimisticSend,
      onOptimisticSendCanceled,
      onSlashCommand,
      onSwitchToTerminal,
      readTerminalScreen
    },
    ref
  ): React.JSX.Element {
    // Scope key shared with image attachments so an unsent draft + its attached
    // images survive both TUI/GUI toggles and PTY replacement on reconnect.
    // Why: local, SSH, and runtime reconnects can replace or temporarily clear
    // the PTY id. Pane identity is the stable ownership key for unsent input.
    const draftScopeKey = paneKey
    const { draft, setDraft } = useNativeChatDraft(draftScopeKey)
    const [caret, setCaret] = useState(draft.length)
    const [history, setHistory] = useState<HistoryState>(EMPTY_HISTORY)
    const [activeSuggestion, setActiveSuggestion] = useState(0)
    const [notice, setNotice] = useState<string | null>(null)
    const [dictationPressed, setDictationPressed] = useState(false)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const isComposingRef = useRef(false)
    const { cancelPendingSends, trackPendingSend } = useNativeChatSendLifecycle(
      terminalTabId,
      targetPtyId,
      onOptimisticSendCanceled
    )
    const dictationState = useAppStore((store) => store.dictationState)
    const voiceSettings = useAppStore((store) => store.settings?.voice)
    const isDictationHoldMode = voiceSettings?.dictationMode === 'hold'
    const dictationDisabled = voiceSettings?.enabled !== true || !voiceSettings.sttModel
    const isDictating =
      dictationPressed ||
      dictationState === 'starting' ||
      dictationState === 'listening' ||
      dictationState === 'stopping'

    // Place the caret at the end of the (possibly restored) draft when the
    // composer is reused for a different pane. Adjusted during render (matching
    // the draft reload) so caret and text stay consistent on the first paint.
    const lastDraftScopeKey = useRef(draftScopeKey)
    if (lastDraftScopeKey.current !== draftScopeKey) {
      lastDraftScopeKey.current = draftScopeKey
      setCaret(readNativeChatDraftCache(draftScopeKey).length)
    }

    const agentCommands = useMemo(() => getVerifiedNativeChatCommands(agent), [agent])
    const picker = useNativeChatPickerState({
      agent,
      terminalTabId,
      draftScopeKey,
      draft,
      caret,
      agentCommands,
      textareaRef,
      setDraft,
      setCaret,
      setActiveSuggestion
    })
    const {
      autocomplete,
      classifySend,
      clearSkillOrigin,
      completeItem,
      dismiss,
      handleDraftOrCaretChange
    } = picker

    // Resolve the live ptyId for this chat leaf; runtime owner settings route
    // local vs remote (SSH) sends.
    const resolveTarget = useCallback((): NativeChatResolvedTarget | null => {
      if (!targetPtyId) {
        return null
      }
      return { ptyId: targetPtyId, settings: getSettingsForAgentTabRuntimeOwner(terminalTabId) }
    }, [targetPtyId, terminalTabId])

    const [hasPty, disabled] = [targetPtyId !== null, targetPtyId === null || !canSend]

    const syncCaret = useCallback((el: HTMLTextAreaElement) => {
      setCaret(el.selectionStart ?? el.value.length)
    }, [])

    const { imageAttachments, attachResolvedPaths, clearImageAttachments, removeImageAttachment } =
      useNativeChatComposerAttachments({
        attachmentScopeKey: paneKey,
        caret,
        resolveTarget,
        textareaRef,
        setCaret,
        setDraft,
        setNotice
      })
    const sendButtonDisabled = isWorking
      ? !hasPty || !onStop
      : disabled || (draft.trim() === '' && imageAttachments.length === 0)

    const { insertTypedText, focus } = useNativeChatTypedInsertion({
      textareaRef,
      caret,
      draft,
      setDraft,
      setCaret,
      setHistory,
      setActiveSuggestion
    })

    const { attachExternalPaths, resolveAttachmentOwner } = useNativeChatExternalAttachments({
      terminalTabId,
      disabled,
      attachResolvedPaths,
      setNotice
    })

    const { handlePaste, pasteFromClipboard } = useNativeChatComposerPaste({
      agent,
      disabled,
      caret,
      resolveAttachmentOwner,
      attachResolvedPaths,
      insertTypedText,
      setCaret,
      setNotice
    })

    useImperativeHandle(
      ref,
      () => ({ focus, insertTypedText, handlePasteEvent: handlePaste, pasteFromClipboard }),
      [focus, insertTypedText, handlePaste, pasteFromClipboard]
    )

    const { pickAttachment } = useNativeChatFileAttachmentActions(attachExternalPaths)
    const { toggleDictation, startHoldDictation, stopHoldDictation } =
      useNativeChatDictationActions({ textareaRef, setDictationPressed })
    const { dispatch: dispatchSessionOptionCommand, isDispatching: isDispatchingSessionOption } =
      useNativeChatSessionOptionCommand({
        agent,
        disabled,
        onSlashCommand,
        resolveTarget,
        setHistory
      })

    const { surface: sessionOptionsSurface, snapshot: sessionOptionsSnapshot } =
      useNativeChatSessionOptions({
        agent,
        terminalTabId,
        targetPtyId,
        dispatchCommand: dispatchSessionOptionCommand,
        onAgentPicker: onSwitchToTerminal,
        readTerminalScreen
      })

    const send = useCallback(() => {
      const text = draft
      const imagePaths = imageAttachments.map((attachment) => attachment.path)
      if ((text.trim() === '' && imagePaths.length === 0) || disabled) {
        return
      }
      // Why: block a normal send while a session-option command (e.g. /model) is
      // still writing its body+delayed-Enter to the same pty, so the two write
      // sequences can't interleave on one input line.
      if (isDispatchingSessionOption) {
        return
      }
      const target = resolveTarget()
      if (!target) {
        return
      }
      const classification = classifySend(text)
      let pendingHandle: NativeChatSendHandle | null = null
      // Why: image attachments take the attachment send path even for a
      // command/unknown send, otherwise `clearImageAttachments()` below drops
      // them silently when the text starts with the agent's slash/skill prefix.
      if (classification !== 'chat' && imagePaths.length === 0) {
        pendingHandle = sendNativeChatMessage(target.settings, target.ptyId, text)
      } else if (imagePaths.length > 0) {
        pendingHandle = sendNativeChatMessageWithImageAttachments(
          target.settings,
          target.ptyId,
          text,
          imagePaths
        )
      } else if (text.trim().length > 0) {
        pendingHandle = sendNativeChatMessage(target.settings, target.ptyId, text)
      } else {
        submitNativeChatPrompt(target.settings, target.ptyId)
      }
      if (classification !== 'chat') {
        if (pendingHandle) {
          trackPendingSend(pendingHandle)
        }
        // Why: only verified catalog commands can truthfully claim they ran or
        // mutate session-option state; unknown slash-like text has no such proof.
        if (classification === 'command') {
          onSlashCommand?.(text.trim())
          sessionOptionsSurface?.recordOutgoingCommand(text.trim())
        }
      } else {
        const pendingId = onOptimisticSend?.(text, imagePaths)
        if (pendingHandle) {
          trackPendingSend(pendingHandle, pendingId)
        }
      }
      // Why: U10 telemetry — record adoption + local-vs-remote runtime split. The
      // agent prop is the loose AgentType; the emitter narrows unknowns to 'other'.
      emitNativeChatMessageSent({
        agent,
        runtime: nativeChatComposerTargetIsRemote(target.ptyId) ? 'remote' : 'local'
      })
      setHistory((prev) => pushHistory(prev, text))
      setDraft('')
      setCaret(0)
      clearSkillOrigin()
      clearImageAttachments()
      setNotice(null)
    }, [
      agent,
      classifySend,
      clearSkillOrigin,
      clearImageAttachments,
      draft,
      imageAttachments,
      disabled,
      isDispatchingSessionOption,
      resolveTarget,
      onOptimisticSend,
      onSlashCommand,
      sessionOptionsSurface,
      trackPendingSend,
      setDraft
    ])

    const interrupt = useCallback(() => {
      cancelPendingSends()
      if (isWorking && onStop) {
        onStop()
        return
      }
      const target = resolveTarget()
      if (!target) {
        return
      }
      sendRuntimePtyInput(target.settings, target.ptyId, ESC)
    }, [cancelPendingSends, isWorking, onStop, resolveTarget])

    const dispatchPickerCommand = useNativeChatPickerCommandDispatch({
      agent,
      disabled,
      isDispatchingSessionOption,
      resolveTarget,
      onSlashCommand,
      sessionOptionsSurface,
      trackPendingSend,
      setHistory,
      setDraft,
      setCaret,
      setActiveSuggestion,
      clearSkillOrigin,
      clearImageAttachments,
      setNotice
    })

    const handleKeyDown = useNativeChatComposerKeyDown({
      autocomplete,
      activeSuggestion,
      draft,
      history,
      isComposing: () => isComposingRef.current,
      completePickerItem: completeItem,
      dispatchPickerCommand,
      dismissPicker: dismiss,
      interrupt,
      send,
      setActiveSuggestion,
      setDraft,
      setCaret,
      setHistory
    })

    return (
      <NativeChatComposerField
        textareaRef={textareaRef}
        draft={draft}
        disabled={disabled}
        hasPty={hasPty}
        canSend={canSend}
        autocomplete={autocomplete}
        activeSuggestion={activeSuggestion}
        notice={notice}
        imageAttachments={imageAttachments}
        sendButtonDisabled={sendButtonDisabled}
        isWorking={isWorking}
        attachDisabled={disabled}
        dictationDisabled={dictationDisabled}
        isDictating={isDictating}
        isDictationHoldMode={isDictationHoldMode}
        onDraftChange={(value, element) => {
          setDraft(value)
          setHistory((prev) => ({ entries: prev.entries, index: null }))
          syncCaret(element)
          handleDraftOrCaretChange(value, element.selectionStart ?? value.length)
          setActiveSuggestion(0)
        }}
        onTextareaSelect={(element) => {
          syncCaret(element)
          handleDraftOrCaretChange(element.value, element.selectionStart ?? element.value.length)
          setActiveSuggestion(0)
        }}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => {
          isComposingRef.current = true
        }}
        onCompositionEnd={() => {
          isComposingRef.current = false
        }}
        onPaste={handlePaste}
        pickerListboxId={picker.listboxId}
        onChoosePickerItem={completeItem}
        onRetrySkills={picker.retrySkills}
        onAcceptMention={() => {
          if (autocomplete.mode !== 'mention') {
            return
          }
          const result = applyMentionSuggestion(draft, caret, autocomplete.query)
          setDraft(result.draft)
          setCaret(result.caret)
          const textarea = textareaRef.current
          textarea?.focus()
          requestAnimationFrame(() => textarea?.setSelectionRange(result.caret, result.caret))
        }}
        onRemoveImageAttachment={(id) => removeImageAttachment(id)}
        onAttach={pickAttachment}
        onDictationToggle={toggleDictation}
        onDictationHoldStart={startHoldDictation}
        onDictationHoldEnd={stopHoldDictation}
        onSend={send}
        onStop={interrupt}
        sessionOptionsSurface={sessionOptionsSurface}
        sessionOptionsSnapshot={sessionOptionsSnapshot}
      />
    )
  }
)

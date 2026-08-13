import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../store'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import {
  applyMentionSuggestion,
  EMPTY_HISTORY,
  type HistoryState
} from './native-chat-composer-state'
import { readNativeChatDraftCache } from './native-chat-draft-cache'
import { useNativeChatDraft } from './use-native-chat-draft'
import { useNativeChatLaunchDraftAdoption } from './use-native-chat-launch-draft-adoption'
import { NativeChatComposerField } from './NativeChatComposerField'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
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
import { useNativeChatComposerSend } from './use-native-chat-composer-send'
import type {
  NativeChatComposerHandle,
  NativeChatComposerProps
} from './native-chat-composer-types'
import { runtimeNativeChatPtyWriter } from './native-chat-pty-writer'

export type {
  NativeChatComposerHandle,
  NativeChatComposerProps
} from './native-chat-composer-types'

// Agent TUIs read plain ESC as the interrupt key over the PTY.
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
      ptyWriter = runtimeNativeChatPtyWriter,
      dictationEnabled = true,
      sessionOptionsEnabled = true,
      fileDropEnabled = true,
      attachmentOwner,
      agent,
      canSend = true,
      isWorking = false,
      onStop,
      onOptimisticSend,
      onOptimisticSendCanceled,
      onSlashCommand,
      onSwitchToTerminal,
      readTerminalScreen,
      launchDraft,
      launchDraftResolved = false
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
    useNativeChatLaunchDraftAdoption({
      terminalTabId,
      agent,
      launchDraft,
      launchDraftResolved,
      draft,
      setDraft,
      setCaret
    })
    const [history, setHistory] = useState<HistoryState>(EMPTY_HISTORY)
    const [activeSuggestion, setActiveSuggestion] = useState(0)
    const [notice, setNotice] = useState<string | null>(null)
    const [verifiedSendPending, setVerifiedSendPending] = useState(false)
    const [verifiedStopPending, setVerifiedStopPending] = useState(false)
    const [dictationPressed, setDictationPressed] = useState(false)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const isComposingRef = useRef(false)
    const verifiedStopPendingRef = useRef(false)
    const { cancelPendingSends, trackPendingSend } = useNativeChatSendLifecycle(
      terminalTabId,
      targetPtyId,
      onOptimisticSendCanceled
    )
    const dictationState = useAppStore((store) => store.dictationState)
    const voiceSettings = useAppStore((store) => store.settings?.voice)
    const isDictationHoldMode = voiceSettings?.dictationMode === 'hold'
    const dictationDisabled =
      !dictationEnabled || voiceSettings?.enabled !== true || !voiceSettings.sttModel
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
      return {
        ptyId: targetPtyId,
        settings: getSettingsForAgentTabRuntimeOwner(terminalTabId),
        writer: ptyWriter
      }
    }, [ptyWriter, targetPtyId, terminalTabId])

    const hasPty = targetPtyId !== null
    const disabled = targetPtyId === null || !canSend || verifiedSendPending

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
      ? !hasPty || !onStop || verifiedStopPending
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
      attachmentOwner,
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

    const { pickAttachment } = useNativeChatFileAttachmentActions(
      attachExternalPaths,
      fileDropEnabled
    )
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
        enabled: sessionOptionsEnabled,
        agent,
        terminalTabId,
        targetPtyId,
        dispatchCommand: dispatchSessionOptionCommand,
        onAgentPicker: onSwitchToTerminal,
        readTerminalScreen
      })
    const send = useNativeChatComposerSend({
      agent,
      draft,
      imageAttachments,
      disabled,
      isDispatchingSessionOption,
      launchDraft,
      launchDraftResolved,
      readTerminalScreen,
      resolveTarget,
      classifySend,
      clearSkillOrigin,
      clearImageAttachments,
      onOptimisticSend,
      onSlashCommand,
      sessionOptionsSurface,
      terminalTabId,
      trackPendingSend,
      setDraft,
      setCaret,
      setHistory,
      setNotice,
      setVerifiedSendPending
    })

    const interrupt = useCallback(() => {
      if (verifiedStopPendingRef.current) {
        return
      }
      cancelPendingSends()
      if (isWorking && onStop) {
        const accepted = onStop()
        if (accepted instanceof Promise) {
          verifiedStopPendingRef.current = true
          setVerifiedStopPending(true)
          void accepted
            .catch(() => false)
            .finally(() => {
              verifiedStopPendingRef.current = false
              setVerifiedStopPending(false)
            })
        }
        return
      }
      const target = resolveTarget()
      if (!target) {
        return
      }
      target.writer.write(target.settings, target.ptyId, ESC)
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
      setNotice,
      setVerifiedSendPending
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

    const handleDraftChange = useCallback(
      (value: string, element: HTMLTextAreaElement) => {
        setDraft(value)
        setHistory((prev) => ({ entries: prev.entries, index: null }))
        syncCaret(element)
        handleDraftOrCaretChange(value, element.selectionStart ?? value.length)
        setActiveSuggestion(0)
      },
      [handleDraftOrCaretChange, setDraft, syncCaret]
    )

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
        fileDropEnabled={fileDropEnabled}
        dictationDisabled={dictationDisabled}
        isDictating={isDictating}
        isDictationHoldMode={isDictationHoldMode}
        onDraftChange={handleDraftChange}
        onTextareaSelect={(element) => {
          syncCaret(element)
          handleDraftOrCaretChange(element.value, element.selectionStart ?? element.value.length)
          setActiveSuggestion(0)
        }}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => {
          isComposingRef.current = true
        }}
        onCompositionEnd={(event) => {
          isComposingRef.current = false
          if (event.currentTarget.value !== draft) {
            handleDraftChange(event.currentTarget.value, event.currentTarget)
          }
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

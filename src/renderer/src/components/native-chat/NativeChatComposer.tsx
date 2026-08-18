import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../store'
import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import {
  isStructuredAgentSessionComposerCommand,
  STRUCTURED_AGENT_SESSION_SLASH_COMMANDS
} from '../../../../shared/structured-agent-session-composer'
import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import {
  applyMentionSuggestion,
  EMPTY_HISTORY,
  pushHistory,
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
import type {
  NativeChatComposerHandle,
  NativeChatComposerProps
} from './native-chat-composer-types'
import { dispatchNativeChatStructuredComposerText } from './native-chat-structured-composer-dispatch'
import { useNativeChatPtyComposerSend } from './use-native-chat-pty-composer-send'

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
      readTerminalScreen,
      launchDraft,
      launchDraftResolved = false,
      structuredTransport
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

    const agentCommands = useMemo(
      () =>
        structuredTransport
          ? STRUCTURED_AGENT_SESSION_SLASH_COMMANDS
          : getVerifiedNativeChatCommands(agent),
      [agent, structuredTransport]
    )
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

    const [hasPty, disabled] = structuredTransport
      ? [true, !canSend]
      : [targetPtyId !== null, targetPtyId === null || !canSend]

    const syncCaret = useCallback((el: HTMLTextAreaElement) => {
      setCaret(el.selectionStart ?? el.value.length)
    }, [])

    const { imageAttachments, attachResolvedPaths, clearImageAttachments, removeImageAttachment } =
      useNativeChatComposerAttachments({
        attachmentScopeKey: paneKey,
        allowWithoutTarget: Boolean(structuredTransport),
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
      structuredWorktreeId: structuredTransport?.worktreeId,
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

    const { surface: ptySessionOptionsSurface, snapshot: ptySessionOptionsSnapshot } =
      useNativeChatSessionOptions({
        agent,
        terminalTabId,
        targetPtyId,
        dispatchCommand: dispatchSessionOptionCommand,
        onAgentPicker: onSwitchToTerminal,
        readTerminalScreen
      })
    const sessionOptionsSurface = structuredTransport?.optionsSurface ?? ptySessionOptionsSurface
    const sessionOptionsSnapshot = structuredTransport?.optionSnapshot ?? ptySessionOptionsSnapshot

    const sendStructured = useCallback(
      (text: string, attachments = imageAttachments): void => {
        if (!structuredTransport) {
          return
        }
        if (attachments.length > 0 && isStructuredAgentSessionComposerCommand(text, agent)) {
          structuredTransport.onError('Remove attachments before using a chat-session command.')
          return
        }
        void dispatchNativeChatStructuredComposerText(structuredTransport, text, attachments)
          .then(({ accepted, error }) => {
            structuredTransport.onError(error)
            if (!accepted) {
              return
            }
            emitNativeChatMessageSent({ agent, runtime: structuredTransport.runtime })
            setHistory((previous) => pushHistory(previous, text))
            setDraft('')
            setCaret(0)
            clearSkillOrigin()
            clearImageAttachments()
          })
          .catch((error) =>
            structuredTransport.onError(error instanceof Error ? error.message : String(error))
          )
      },
      [
        agent,
        clearImageAttachments,
        clearSkillOrigin,
        imageAttachments,
        setDraft,
        structuredTransport
      ]
    )

    const sendPty = useNativeChatPtyComposerSend({
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
      onOptimisticSend,
      onSlashCommand,
      sessionOptionsSurface: ptySessionOptionsSurface,
      terminalTabId,
      trackPendingSend,
      setHistory,
      setDraft,
      setCaret,
      clearSkillOrigin,
      clearImageAttachments,
      setNotice
    })
    const send = useCallback(() => {
      if (!structuredTransport) {
        sendPty()
      } else if ((draft.trim() !== '' || imageAttachments.length > 0) && !disabled) {
        sendStructured(draft, imageAttachments)
      }
    }, [disabled, draft, imageAttachments, sendPty, sendStructured, structuredTransport])

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

    const dispatchPtyPickerCommand = useNativeChatPickerCommandDispatch({
      agent,
      disabled,
      isDispatchingSessionOption,
      resolveTarget,
      onSlashCommand,
      sessionOptionsSurface: ptySessionOptionsSurface,
      trackPendingSend,
      setHistory,
      setDraft,
      setCaret,
      setActiveSuggestion,
      clearSkillOrigin,
      clearImageAttachments,
      setNotice
    })
    const dispatchPickerCommand = useCallback(
      (command: Parameters<typeof dispatchPtyPickerCommand>[0]) => {
        if (structuredTransport) {
          sendStructured(`/${command.name}`)
          return
        }
        dispatchPtyPickerCommand(command)
      },
      [dispatchPtyPickerCommand, sendStructured, structuredTransport]
    )

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
        sessionOptionsPickerRequest={structuredTransport?.optionPickerRequest ?? null}
      />
    )
  }
)

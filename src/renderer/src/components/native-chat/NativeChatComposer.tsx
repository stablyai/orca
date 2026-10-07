import { useNativeChatComposerNotice } from './use-native-chat-composer-notice'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { forwardRef, useCallback, useState } from 'react'
import { useNativeChatComposerInterrupt } from './use-native-chat-composer-interrupt'
import { useNativeChatContextUsageSummary } from './use-native-chat-context-usage-summary'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { EMPTY_HISTORY, type HistoryState } from './native-chat-composer-state'
import { useNativeChatMentionFiles } from './use-native-chat-mention-files'
import { useNativeChatDraft } from './use-native-chat-draft'
import { useNativeChatLaunchDraftAdoption } from './use-native-chat-launch-draft-adoption'
import { NativeChatComposerField } from './NativeChatComposerField'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import { useNativeChatComposerAttachments } from './use-native-chat-composer-attachments'
import { nativeChatImageSendBlock } from './native-chat-image-reattach'
import { useNativeChatComposerHandle } from './use-native-chat-composer-handle'
import { useNativeChatExternalAttachments } from './use-native-chat-external-attachments'
import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'
import { useNativeChatSendLifecycle } from './use-native-chat-send-lifecycle'
import { useNativeChatSessionOptions } from './use-native-chat-session-options'
import { useNativeChatFileAttachmentActions } from './use-native-chat-file-attachment-actions'
import { useNativeChatDictation } from './use-native-chat-dictation'
import { useNativeChatSessionOptionCommand } from './use-native-chat-session-option-command'
import { useNativeChatComposerCatalog } from './use-native-chat-composer-catalog'
import { useNativeChatPickerState } from './use-native-chat-picker-state'
import { useNativeChatPickerCommandDispatch } from './use-native-chat-picker-command-dispatch'
import type {
  NativeChatComposerHandle,
  NativeChatComposerProps
} from './native-chat-composer-types'
import { useNativeChatPtyComposerSend } from './use-native-chat-pty-composer-send'
import { useNativeChatHeldQueueComposerSend } from './use-native-chat-held-queue-composer-send'
import { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'
import { useNativeChatComposerAppMenuSelection } from './use-native-chat-composer-app-menu-selection'
import { useNativeChatWorkspaceFileDrop } from './use-native-chat-workspace-file-drop'
import { useNativeChatComposerSubmit } from './use-native-chat-composer-submit'

export type {
  NativeChatComposerHandle,
  NativeChatComposerProps
} from './native-chat-composer-types'

/**
 * Rich native input for the chat view. Sends prompts into the running agent
 * through the same verified runtime path as typed input (KTD4), so the agent
 * cannot distinguish native input from keystrokes. Enter sends; Shift+Enter
 * inserts a newline; multi-line is bracketed-paste wrapped; Esc interrupts.
 * Slash-command and `@file` autocomplete are agent-aware; image paste persists a
 * temp file and injects the agent-appropriate path (or reports unsupported).
 */
const NativeChatComposerPane = forwardRef<NativeChatComposerHandle, NativeChatComposerProps>(
  function NativeChatComposerPane(
    {
      terminalTabId,
      paneKey,
      draftScopeKey = paneKey,
      targetPtyId,
      agent,
      canSend = true,
      isWorking = false,
      isStopping = false,
      afterStop,
      onStop,
      onOptimisticSend,
      optimisticSendOutcome,
      onOptimisticSendCanceled,
      onSlashCommand,
      onSubmitted,
      answerCommandLocally,
      onSwitchToTerminal,
      readTerminalScreen,
      launchSeed,
      structuredTransport,
      steerQueued,
      inputOwnedByCard = false,
      notices: chatNotices
    },
    ref
  ): React.JSX.Element {
    // Scope key shared with image attachments so an unsent draft + its attached
    // images survive both TUI/GUI toggles and PTY replacement on reconnect.
    // Why: local, SSH, and runtime reconnects can replace or temporarily clear
    // the PTY id. Pane (or conversation) identity is the stable owner of unsent input.
    const imeEnterGesture = useImeEnterGestureOwnership()
    const { draft, setDraft, flushDraftAppends } = useNativeChatDraft(
      draftScopeKey,
      imeEnterGesture.isComposing
    )
    const [caret, setCaret] = useState(draft.length)
    useNativeChatLaunchDraftAdoption({
      terminalTabId,
      agent,
      launchDraft: launchSeed?.launchDraft,
      launchDraftResolved: launchSeed?.launchDraftResolved === true,
      ownsTabWideLaunchDraft: launchSeed?.ownsTabWideLaunchDraft === true,
      draft,
      setDraft,
      setCaret
    })
    const [history, setHistory] = useState<HistoryState>(EMPTY_HISTORY)
    const [activeSuggestion, setActiveSuggestion] = useState(0)
    const { notices, setNotice } = useNativeChatComposerNotice(chatNotices)
    const { textareaRef } = useNativeChatComposerAppMenuSelection(imeEnterGesture.isComposing)
    const { cancelPendingSends, trackPendingSend } = useNativeChatSendLifecycle(
      terminalTabId,
      targetPtyId,
      onOptimisticSendCanceled,
      { inputOwnedByCard, onPendingSendRetired: optimisticSendOutcome?.reject }
    )

    const { agentCommands, sessionSkillNames } = useNativeChatComposerCatalog(
      agent,
      structuredTransport
    )
    const picker = useNativeChatPickerState({
      agent,
      terminalTabId,
      draftScopeKey: paneKey,
      draft,
      caret,
      agentCommands,
      recalledFromHistory: history.index !== null,
      sessionSkillNames,
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
      completeMention,
      dismiss,
      handleDraftOrCaretChange
    } = picker
    const mentionFiles = useNativeChatMentionFiles({
      query: autocomplete.mode === 'mention' ? autocomplete.query : null,
      terminalTabId,
      structuredWorktreeId: structuredTransport?.worktreeId
    })

    // Resolve the live ptyId for this chat leaf; runtime owner settings route
    // local vs remote (SSH) sends.
    const resolveTarget = useCallback((): NativeChatResolvedTarget | null => {
      if (!targetPtyId) {
        return null
      }
      return { ptyId: targetPtyId, settings: getSettingsForAgentTabRuntimeOwner(terminalTabId) }
    }, [targetPtyId, terminalTabId])

    // Why inputOwnedByCard: the hidden field can still hold keyboard focus for a frame.
    const [hasPty, disabled] = structuredTransport
      ? [true, !canSend]
      : [targetPtyId !== null, targetPtyId === null || !canSend || inputOwnedByCard]

    const syncCaret = useCallback((el: NativeChatComposerInput) => {
      setCaret(el.selectionStart ?? el.value.length)
    }, [])

    const attachments = useNativeChatComposerAttachments({
      attachmentScopeKey: draftScopeKey,
      allowWithoutTarget: Boolean(structuredTransport),
      acceptsImages: structuredTransport?.acceptsImages !== false,
      caret,
      disabled,
      isComposing: imeEnterGesture.isComposing,
      resolveTarget,
      textareaRef,
      setCaret,
      setDraft,
      setNotice
    })
    const {
      imageAttachments,
      attachResolvedPaths,
      clearImageAttachments,
      removeImageAttachment,
      beginPendingImageAttachment,
      resolvePendingImageAttachment,
      dropPendingImageAttachment
    } = attachments
    useNativeChatWorkspaceFileDrop({
      terminalTabId,
      structuredWorktreeId: structuredTransport?.worktreeId,
      disabled,
      paneKey,
      attachResolvedPaths,
      setNotice
    })
    const imageBlock = nativeChatImageSendBlock(imageAttachments)
    const sendButtonDisabled = isWorking
      ? !hasPty || !onStop
      : disabled || imageBlock.holdsSend || (draft.trim() === '' && imageAttachments.length === 0)

    const { attachExternalPaths, resolveAttachmentOwner } = useNativeChatExternalAttachments({
      terminalTabId,
      structuredWorktreeId: structuredTransport?.worktreeId,
      disabled,
      attachResolvedPaths,
      setNotice
    })

    const handlePasteEvent = useNativeChatComposerHandle(ref, {
      textareaRef,
      caret,
      draft,
      setDraft,
      setCaret,
      setHistory,
      setActiveSuggestion,
      targetKey: JSON.stringify([
        paneKey,
        targetPtyId,
        structuredTransport?.sessionId,
        structuredTransport?.worktreeId,
        structuredTransport?.runtimeEnvironmentId
      ]),
      agent,
      disabled,
      resolveAttachmentOwner,
      attachResolvedPaths,
      beginPendingImageAttachment,
      resolvePendingImageAttachment,
      dropPendingImageAttachment,
      setNotice
    })

    const { pickAttachments } = useNativeChatFileAttachmentActions(paneKey, attachExternalPaths)
    const dictation = useNativeChatDictation(textareaRef)
    const { dispatch: dispatchSessionOptionCommand, isDispatching: isDispatchingSessionOption } =
      useNativeChatSessionOptionCommand({
        agent,
        disabled,
        onSlashCommand,
        onSubmitted,
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
        readTerminalScreen,
        paneKey
      })
    const sessionOptionsSurface = structuredTransport?.optionsSurface ?? ptySessionOptionsSurface
    const contextUsageSummary = useNativeChatContextUsageSummary(structuredTransport)
    const sessionOptionsSnapshot = structuredTransport?.optionSnapshot ?? ptySessionOptionsSnapshot

    const { send: sendStructured, fieldProps: queue } = useNativeChatHeldQueueComposerSend({
      agent,
      draftScopeKey,
      imageAttachments,
      structuredTransport,
      isComposing: imeEnterGesture.isComposing,
      clearSkillOrigin,
      setHistory,
      setDraft,
      setCaret
    })

    // What both terminal send paths share: where a command goes and what the composer resets.
    const ptyCommandRouting = {
      agent,
      disabled,
      isDispatchingSessionOption,
      resolveTarget,
      onSlashCommand,
      onSubmitted,
      answerCommandLocally,
      sessionOptionsSurface: ptySessionOptionsSurface,
      trackPendingSend,
      setHistory,
      setDraft,
      setCaret,
      clearSkillOrigin,
      clearImageAttachments,
      setNotice
    }
    const sendPty = useNativeChatPtyComposerSend({
      ...ptyCommandRouting,
      draft,
      imageAttachments,
      launchDraft: launchSeed?.launchDraft,
      launchDraftResolved: launchSeed?.launchDraftResolved === true,
      readTerminalScreen,
      classifySend,
      onOptimisticSend,
      optimisticSendOutcome,
      terminalTabId
    })
    const { send, goalMode } = useNativeChatComposerSubmit({
      structuredTransport,
      draftScopeKey,
      draft,
      caret,
      imageAttachments,
      disabled,
      sendPty,
      sendStructured,
      setDraft,
      setCaret,
      setHistory
    })

    const interrupt = useNativeChatComposerInterrupt({
      inert: inputOwnedByCard,
      cancelPendingSends,
      isWorking,
      onStop,
      resolveTarget
    })

    const dispatchPtyPickerCommand = useNativeChatPickerCommandDispatch({
      ...ptyCommandRouting,
      setActiveSuggestion
    })
    const dispatchPickerCommand = useCallback(
      (command: Parameters<typeof dispatchPtyPickerCommand>[0]) =>
        structuredTransport
          ? sendStructured(`/${command.name}`)
          : dispatchPtyPickerCommand(command),
      [dispatchPtyPickerCommand, sendStructured, structuredTransport]
    )

    const handleKeyDown = useNativeChatComposerKeyDown({
      autocomplete,
      mentionFiles,
      completeMention,
      activeSuggestion,
      draft,
      history,
      isComposing: imeEnterGesture.isComposing,
      completePickerItem: goalMode.interceptPick(completeItem),
      dispatchPickerCommand: goalMode.interceptPick(dispatchPickerCommand),
      dismissPicker: dismiss,
      interrupt,
      send,
      hasAttachments: imageAttachments.length > 0,
      ...(steerQueued ? { steerQueued } : {}),
      setActiveSuggestion,
      setDraft,
      setCaret,
      setHistory
    })

    const handleDraftChange = useCallback(
      (value: string, element: NativeChatComposerInput) => {
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
        dropScopeKey={paneKey}
        draftScopeKey={draftScopeKey}
        textareaRef={textareaRef}
        draft={draft}
        disabled={disabled}
        hasPty={hasPty}
        canSend={canSend}
        autocomplete={autocomplete}
        mentionFiles={mentionFiles}
        activeSuggestion={activeSuggestion}
        notices={notices}
        imageAttachments={imageAttachments}
        sendButtonDisabled={sendButtonDisabled}
        sendBlockedReason={imageBlock.reason}
        isWorking={isWorking}
        isStopping={isStopping}
        afterStop={afterStop}
        attachDisabled={disabled}
        dictationDisabled={dictation.dictationDisabled}
        isDictating={dictation.isDictating}
        isDictationHoldMode={dictation.isDictationHoldMode}
        imeEnterGesture={imeEnterGesture}
        onDraftChange={handleDraftChange}
        onTextareaSelect={(element) => {
          syncCaret(element)
          handleDraftOrCaretChange(element.value, element.selectionStart ?? element.value.length)
          setActiveSuggestion(0)
        }}
        onKeyDown={handleKeyDown}
        onImeSettled={(element) => {
          if (element.value !== draft) {
            handleDraftChange(element.value, element)
          }
          flushDraftAppends()
          attachments.flushPendingAttachments()
        }}
        onPaste={handlePasteEvent}
        pickerListboxId={picker.listboxId}
        onChoosePickerItem={goalMode.interceptPick(completeItem)}
        goalMode={goalMode}
        onRetrySkills={picker.retrySkills}
        onChooseMentionFile={completeMention}
        onRemoveImageAttachment={(id) => removeImageAttachment(id)}
        onAttach={pickAttachments}
        onDictationToggle={dictation.toggleDictation}
        onDictationHoldStart={dictation.startHoldDictation}
        onDictationHoldEnd={dictation.stopHoldDictation}
        onSend={send}
        onStop={interrupt}
        {...queue}
        sessionOptionsSurface={sessionOptionsSurface}
        sessionOptionsSnapshot={sessionOptionsSnapshot}
        contextUsage={contextUsageSummary}
        sessionOptionsPickerRequest={structuredTransport?.optionPickerRequest ?? null}
      />
    )
  }
)

export const NativeChatComposer = forwardRef<NativeChatComposerHandle, NativeChatComposerProps>(
  function NativeChatComposer(props, ref): React.JSX.Element {
    return <NativeChatComposerPane key={props.paneKey} {...props} ref={ref} />
  }
)

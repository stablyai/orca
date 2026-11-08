import { useNativeChatComposerEditSession } from '../queue/editing/use-native-chat-composer-edit-session'
import { useNativeChatComposerNotice } from './controls/use-native-chat-composer-notice'
import { useNativeChatMobileHoldNotice } from '../host-access/use-native-chat-mobile-hold-notice'
import { forwardRef, useCallback, useState, useRef } from 'react'
import { useNativeChatComposerInterrupt } from './submit/use-native-chat-composer-interrupt'
import { useNativeChatContextUsageSummary } from '../usage/use-native-chat-context-usage-summary'
import { useNativeChatMentionFiles } from './pickers/use-native-chat-mention-files'
import { useNativeChatDraft } from '../drafts/use-native-chat-draft'
import { useNativeChatDraftEvents } from './editor/use-native-chat-draft-events'
import { useNativeChatComposerRecall } from '../drafts/use-native-chat-composer-recall'
import { useNativeChatLaunchDraftAdoption } from '../drafts/use-native-chat-launch-draft-adoption'
import { NativeChatComposerWorkspace } from './controls/NativeChatComposerWorkspace'
import { NativeChatComposerField } from './editor/NativeChatComposerField'
import { useNativeChatComposerAttachments } from '../attachments/chips/use-native-chat-composer-attachments'
import { nativeChatComposerSendState } from './submit/native-chat-composer-send-state'
import { useNativeChatSteerChordPreview } from './controls/use-native-chat-steer-chord-preview'
import { useNativeChatComposerHandle } from './editor/use-native-chat-composer-handle'
import { useNativeChatFileDrops } from '../attachments/intake/use-native-chat-file-drops'
import { useNativeChatComposerKeyDown } from './editor/use-native-chat-composer-keydown'
import { useNativeChatSendLifecycle } from '../session/terminal/send/use-native-chat-send-lifecycle'
import { useNativeChatComposerSessionOptions } from './controls/use-native-chat-composer-session-options'
import { useNativeChatDictation } from './editor/use-native-chat-dictation'
import { useNativeChatPtyComposerSend } from './submit/use-native-chat-pty-composer-send'
import { useNativeChatStructuredComposerSend } from './submit/use-native-chat-structured-composer-send'
import { useImeEnterGestureOwnership } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { useNativeChatComposerAppMenuSelection } from './focus/use-native-chat-composer-app-menu-selection'
import { useNativeChatComposerSubmit } from './submit/use-native-chat-composer-submit'
import { useNativeChatComposerCommandPicker } from './pickers/use-native-chat-composer-command-picker'
import type * as C from './native-chat-composer-types'

type ComposerHandle = C.NativeChatComposerHandle

/** Send through the chat’s structured transport or verified PTY route, with agent-aware autocomplete and image handling. */
export const NativeChatComposerPane = forwardRef<ComposerHandle, C.NativeChatComposerProps>(
  function NativeChatComposerPane(
    {
      terminalTabId,
      editSession,
      paneKey,
      draftScopeKey = paneKey,
      targetPtyId,
      agent,
      canSend = true,
      unavailableHint,
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
      steerHead,
      recallSource,
      submissionSource,
      inputOwnedByCard = false,
      notices: chatNotices,
      workspacePending: pending = false,
      launchPrompt
    },
    ref
  ): React.JSX.Element {
    // Own drafts and attachments by pane/conversation so reconnect PTY replacement and UI mode changes cannot discard unsent input.
    const imeEnterGesture = useImeEnterGestureOwnership()
    const draftState = useNativeChatDraft(draftScopeKey, imeEnterGesture.isComposing)
    const { draft, setDraft, flushDraftAppends } = draftState
    const [caret, setCaret] = useState(draft.length)
    useNativeChatLaunchDraftAdoption({
      terminalTabId,
      agent,
      launchSeed,
      draft,
      setDraft,
      setCaret
    })
    const [activeSuggestion, setActiveSuggestion] = useState(0)
    const holdNotice = useNativeChatMobileHoldNotice(
      structuredTransport ? null : targetPtyId,
      canSend
    )
    const { notices, setNotice } = useNativeChatComposerNotice(chatNotices, holdNotice)
    const { textareaRef } = useNativeChatComposerAppMenuSelection(imeEnterGesture.isComposing)
    const recall = useNativeChatComposerRecall({
      draft,
      source: recallSource,
      inputRef: textareaRef
    })
    const { cancelPendingSends, trackPendingSend } = useNativeChatSendLifecycle(
      terminalTabId,
      targetPtyId,
      onOptimisticSendCanceled,
      { inputOwnedByCard, onPendingSendRetired: optimisticSendOutcome?.reject }
    )

    // Why inputOwnedByCard: the hidden field can still hold keyboard focus for a frame.
    const [hasPty, disabled] = structuredTransport
      ? [true, !canSend || unavailableHint !== undefined]
      : [targetPtyId !== null, targetPtyId === null || !canSend || inputOwnedByCard]
    const attachDisabled =
      disabled ||
      (structuredTransport?.runtime === 'remote' && structuredTransport.sessionPending === true)

    const { picker, orcaCommands } = useNativeChatComposerCommandPicker({
      mode: editSession ? 'edit' : launchPrompt || pending ? 'launch' : undefined,
      agent,
      terminalTabId,
      draftScopeKey: paneKey,
      draft,
      caret,
      recalledFromHistory: recall.active,
      disabled,
      isComposing: imeEnterGesture.isComposing,
      structuredTransport,
      editor: { textareaRef, setDraft, setCaret, setActiveSuggestion },
      setNotice
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

    const resolveTarget = useCallback(
      () => (targetPtyId ? { ptyId: targetPtyId } : null),
      [targetPtyId]
    )

    const attachments = useNativeChatComposerAttachments({
      attachmentScopeKey: draftScopeKey,
      allowWithoutTarget: Boolean(structuredTransport),
      acceptsImages: structuredTransport?.acceptsImages !== false,
      imageReferences: Boolean(structuredTransport),
      caret,
      disabled,
      isComposing: imeEnterGesture.isComposing,
      resolveTarget,
      textareaRef,
      setCaret,
      setDraft,
      setNotice
    })
    const { imageAttachments, attachResolvedPaths, clearImageAttachments } = attachments

    const fileDrops = useNativeChatFileDrops({
      paneKey,
      draftScopeKey,
      targetPtyId,
      structuredTransport,
      terminalTabId,
      structuredWorktreeId: structuredTransport?.worktreeId,
      structuredSession: structuredTransport,
      disabled,
      attachResolvedPaths,
      pendingChips: attachments.pendingChips,
      setNotice
    })

    const localHandle = useRef<C.NativeChatComposerHandle>(null)
    const root = useRef<HTMLDivElement>(null)
    const handlePasteEvent = useNativeChatComposerHandle(localHandle, {
      resend: (text, imagePaths) => !structuredTransport && sendPty({ text, imagePaths }),
      attachmentScopeKey: draftScopeKey,
      textareaRef,
      isComposing: imeEnterGesture.isComposing,
      caret,
      setDraft,
      setCaret,
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
      resolveAttachmentOwner: fileDrops.resolveAttachmentOwner,
      attachResolvedPaths,
      attachCopiedFiles: fileDrops.attachExternalPaths,
      captureCopiedFiles: fileDrops.captureCopiedFiles,
      captureExternalPaths: fileDrops.captureExternalPaths,
      beginPendingImageAttachment: attachments.beginPendingImageAttachment,
      // Settles into the scope cache, which outlives a composer a prompt card unmounted.
      resolvePendingImageAttachment: attachments.pendingChips.resolve,
      revealPendingImageAttachment: attachments.revealPendingImageAttachment,
      dropPendingImageAttachment: attachments.dropPendingImageAttachment,
      pastedTextEditor: structuredTransport ? attachments.scopeEditor : null,
      setNotice
    })

    const dictation = useNativeChatDictation(textareaRef, disabled)
    const sessionOptions = useNativeChatComposerSessionOptions({
      agent,
      disabled,
      onSlashCommand,
      onSubmitted,
      resolveTarget,
      terminalTabId,
      targetPtyId,
      onSwitchToTerminal,
      readTerminalScreen,
      paneKey,
      structuredTransport
    })
    const contextUsageSummary = useNativeChatContextUsageSummary(structuredTransport)

    const sendStructured = useNativeChatStructuredComposerSend({
      agent,
      recallSource,
      submissionSource,
      draftScopeKey,
      imageAttachments,
      structuredTransport,
      isComposing: imeEnterGesture.isComposing,
      clearSkillOrigin,
      setDraft,
      setCaret
    })

    const ptyCommandRouting = {
      agent,
      disabled,
      isDispatchingSessionOption: sessionOptions.isDispatching,
      resolveTarget,
      onSlashCommand,
      onSubmitted,
      answerCommandLocally,
      sessionOptionsSurface: sessionOptions.pty.surface,
      trackPendingSend,
      setDraft,
      setCaret,
      clearSkillOrigin,
      clearImageAttachments,
      setNotice
    }
    const sendPty = useNativeChatPtyComposerSend({
      draftScopeKey,
      recallSource,
      submissionSource,
      ...ptyCommandRouting,
      draft,
      imageAttachments,
      launchDraft: launchSeed?.launchDraft,
      launchDraftResolved: launchSeed?.launchDraftResolved === true,
      readTerminalDraft: launchSeed?.readTerminalDraft,
      classifySend,
      onOptimisticSend,
      optimisticSendOutcome,
      terminalTabId
    })
    const submission = useNativeChatComposerSubmit({
      agent,
      textareaRef,
      structuredTransport,
      draftScopeKey,
      draft,
      caret,
      imageAttachments,
      disabled,
      sendPty,
      sendStructured,
      submitEmpty: launchPrompt?.onEmptySubmit,
      consumeOrcaCommand: pending || launchPrompt ? undefined : orcaCommands.consume,
      matchesOrcaCommand: pending || launchPrompt ? undefined : orcaCommands.matchesDraft,
      setDraft,
      setCaret
    })

    const { goalMode } = submission
    const { sendHeld, ...sendButton } = nativeChatComposerSendState({
      agent,
      draft,
      messageDelivery: submission.messageDelivery,
      imageAttachments,
      pastedTextSaving: attachments.pastedTextSaving,
      disabled,
      structuredTransport,
      editSession,
      isWorking,
      canStop: hasPty && onStop !== undefined,
      orcaCommand: !pending && !launchPrompt && orcaCommands.matchesDraft(draft),
      goalMode: goalMode.active
    })

    const { send, chooseEditItem, fieldOverrides, dispatchPickerCommand } =
      useNativeChatComposerEditSession({
        editSession,
        root,
        handle: localHandle,
        ref,
        draftScopeKey,
        agent,
        disabled,
        sendHeld,
        ...picker,
        structuredTransport,
        sendStructured,
        ptyCommandRouting: { ...ptyCommandRouting, setActiveSuggestion },
        setNotice,
        sendMessage: submission.send
      })

    const interrupt = useNativeChatComposerInterrupt({
      inert: inputOwnedByCard,
      cancelPendingSends,
      isWorking,
      onStop,
      resolveTarget
    })

    const handleKeyDown = useNativeChatComposerKeyDown({
      autocomplete,
      mentionFiles,
      completeMention,
      activeSuggestion,
      draft,
      recall: editSession ? undefined : recall.recall,
      isComposing: imeEnterGesture.isComposing,
      completePickerItem: editSession ? chooseEditItem : goalMode.interceptPick(completeItem),
      dispatchPickerCommand: editSession
        ? chooseEditItem
        : goalMode.interceptPick(orcaCommands.interceptPick(dispatchPickerCommand)),
      dismissPicker: dismiss,
      interrupt: editSession?.cancel ?? interrupt,
      send,
      hasAttachments: imageAttachments.length > 0,
      ...(!editSession && steerHead ? { steerHead } : {}),
      chordSteersHead: sendButton.chordSteersHead,
      setActiveSuggestion: picker.navigateSuggestion,
      setDraft,
      setCaret
    })

    const pickerOpen = autocomplete.mode !== 'none'
    const steerChord = useNativeChatSteerChordPreview(root, sendButton, steerHead, send, pickerOpen)

    const draftEvents = useNativeChatDraftEvents({
      draft,
      setDraft,
      setCaret,
      setActiveSuggestion,
      handleDraftOrCaretChange,
      flushDraftAppends,
      flushPendingAttachments: attachments.flushPendingAttachments
    })

    return (
      <div ref={root} data-native-chat-composer-scope={draftScopeKey}>
        <NativeChatComposerField
          draftScopeKey={draftScopeKey}
          positionTarget={editSession ? undefined : terminalTabId}
          textareaRef={textareaRef}
          draft={draft}
          disabled={disabled}
          hasPty={hasPty}
          canSend={canSend}
          unavailableHint={unavailableHint}
          autocomplete={autocomplete}
          mentionFiles={mentionFiles}
          activeSuggestion={activeSuggestion}
          notices={notices}
          imageAttachments={imageAttachments}
          numberImages={Boolean(structuredTransport)}
          attachmentEnvironmentId={structuredTransport?.runtimeEnvironmentId ?? undefined}
          {...sendButton}
          isWorking={isWorking}
          isStopping={isStopping}
          afterStop={afterStop}
          attachDisabled={attachDisabled}
          dictationDisabled={dictation.dictationDisabled}
          isDictating={dictation.isDictating}
          isDictationHoldMode={dictation.isDictationHoldMode}
          imeEnterGesture={imeEnterGesture}
          {...draftEvents}
          onKeyDown={handleKeyDown}
          onPaste={handlePasteEvent}
          pickerListboxId={picker.listboxId}
          onChoosePickerItem={goalMode.interceptPick(orcaCommands.interceptPick(completeItem))}
          goalMode={goalMode}
          onRetrySkills={picker.retrySkills}
          onChooseMentionFile={completeMention}
          onRemoveImageAttachment={attachments.removeImageAttachment}
          onAttach={fileDrops.pickAttachments}
          onDictationToggle={dictation.toggleDictation}
          onDictationHoldStart={dictation.startHoldDictation}
          onDictationHoldEnd={dictation.stopHoldDictation}
          onSend={send}
          steerPreview={steerChord.preview}
          onSteerPreview={steerChord.runPreview}
          onStop={interrupt}
          sessionOptionsSurface={sessionOptions.surface}
          sessionOptionsSnapshot={sessionOptions.snapshot}
          contextUsage={contextUsageSummary}
          sessionOptionsPickerRequest={structuredTransport?.optionPickerRequest ?? null}
          agent={agent}
          launchPrompt={launchPrompt}
          workspaceFooter={
            !editSession && !launchPrompt ? (
              <NativeChatComposerWorkspace
                terminalTabId={terminalTabId}
                structuredTransport={structuredTransport}
                isWorking={isWorking}
              />
            ) : undefined
          }
          {...fieldOverrides}
        />
      </div>
    )
  }
)

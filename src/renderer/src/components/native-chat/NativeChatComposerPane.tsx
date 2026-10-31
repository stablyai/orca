import { useNativeChatComposerEditSession } from './use-native-chat-composer-edit-session'
import { useNativeChatComposerNotice } from './use-native-chat-composer-notice'
import { useNativeChatMobileHoldNotice } from './use-native-chat-mobile-hold-notice'
import { forwardRef, useCallback, useState, useRef, useImperativeHandle } from 'react'
import { useNativeChatComposerInterrupt } from './use-native-chat-composer-interrupt'
import { useNativeChatContextUsageSummary } from './use-native-chat-context-usage-summary'
import { useNativeChatMentionFiles } from './use-native-chat-mention-files'
import { useNativeChatDraft } from './use-native-chat-draft'
import { useNativeChatDraftEvents } from './use-native-chat-draft-events'
import { useNativeChatComposerRecall } from './use-native-chat-composer-recall'
import { useNativeChatLaunchDraftAdoption } from './use-native-chat-launch-draft-adoption'
import { NativeChatComposerField } from './NativeChatComposerField'
import { useNativeChatComposerAttachments } from './use-native-chat-composer-attachments'
import { nativeChatImageSendBlock } from './native-chat-image-reattach'
import { useNativeChatComposerHandle } from './use-native-chat-composer-handle'
import { useNativeChatFileDrops } from './use-native-chat-file-drops'
import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'
import { useNativeChatSendLifecycle } from './use-native-chat-send-lifecycle'
import { useNativeChatSessionOptions } from './use-native-chat-session-options'
import { useNativeChatDictation } from './use-native-chat-dictation'
import { useNativeChatSessionOptionCommand } from './use-native-chat-session-option-command'
import type * as C from './native-chat-composer-types'
import { useNativeChatPtyComposerSend } from './use-native-chat-pty-composer-send'
import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'
import { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'
import { useNativeChatComposerAppMenuSelection } from './use-native-chat-composer-app-menu-selection'
import { useNativeChatComposerSubmit } from './use-native-chat-composer-submit'
import { useNativeChatComposerCommandPicker } from './use-native-chat-composer-command-picker'
import { useNotificationCardComposerClearance } from '@/lib/notification-card-composer-clearance'

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
      inputOwnedByCard = false,
      notices: chatNotices,
      workspacePending: pending = false
    },
    ref
  ): React.JSX.Element {
    // Own drafts and attachments by pane/conversation so reconnect PTY replacement and UI mode changes cannot discard unsent input.
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
      pending ||
      (structuredTransport?.runtime === 'remote' && structuredTransport.sessionPending === true)

    const { picker, resume } = useNativeChatComposerCommandPicker({
      editing: editSession !== undefined,
      agent,
      terminalTabId,
      draftScopeKey: paneKey,
      draft,
      caret,
      recalledFromHistory: recall.active,
      disabled: disabled || pending,
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

    const resolveTarget = useCallback(() => {
      if (!targetPtyId) {
        return null
      }
      return { ptyId: targetPtyId }
    }, [targetPtyId])

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
    const { imageAttachments, attachResolvedPaths, clearImageAttachments, removeImageAttachment } =
      attachments
    const imageBlock = nativeChatImageSendBlock(imageAttachments)
    const sendBlockedReason = imageBlock.reason ?? structuredTransport?.sendBlockedReason ?? null
    const sendHeld =
      attachments.pastedTextSaving ||
      disabled ||
      structuredTransport?.sendOut === true ||
      imageBlock.holdsSend ||
      structuredTransport?.sendBlockedReason !== undefined
    const sendButtonDisabled = editSession
      ? sendHeld || !editSession.canSave
      : isWorking
        ? !hasPty || !onStop
        : sendHeld || (draft.trim() === '' && imageAttachments.length === 0)

    const {
      pickAttachments,
      attachExternalPaths,
      captureExternalPaths,
      captureCopiedFiles,
      resolveAttachmentOwner
    } = useNativeChatFileDrops({
      paneKey,
      draftScopeKey,
      targetPtyId,
      structuredTransport,
      terminalTabId,
      structuredWorktreeId: structuredTransport?.worktreeId,
      structuredSession: structuredTransport,
      disabled: disabled || pending,
      attachResolvedPaths,
      pendingChips: attachments.pendingChips,
      setNotice
    })

    const localHandle = useRef<C.NativeChatComposerHandle>(null)
    const root = useRef<HTMLDivElement>(null)
    useNotificationCardComposerClearance(root, editSession === undefined)
    const handlePasteEvent = useNativeChatComposerHandle(localHandle, {
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
      resolveAttachmentOwner,
      attachResolvedPaths,
      attachCopiedFiles: attachExternalPaths,
      captureCopiedFiles,
      captureExternalPaths,
      beginPendingImageAttachment: attachments.beginPendingImageAttachment,
      // Settles into the scope cache, which outlives a composer a prompt card unmounted.
      resolvePendingImageAttachment: attachments.pendingChips.resolve,
      revealPendingImageAttachment: attachments.revealPendingImageAttachment,
      dropPendingImageAttachment: attachments.dropPendingImageAttachment,
      pastedTextEditor: structuredTransport && !pending ? attachments.scopeEditor : null,
      setNotice
    })

    useImperativeHandle(ref, () => localHandle.current!)
    const dictation = useNativeChatDictation(textareaRef, disabled)
    const { dispatch: dispatchSessionOptionCommand, isDispatching: isDispatchingSessionOption } =
      useNativeChatSessionOptionCommand({
        agent,
        disabled,
        onSlashCommand,
        onSubmitted,
        resolveTarget
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

    const sendStructured = useNativeChatStructuredComposerSend({
      agent,
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
      isDispatchingSessionOption,
      resolveTarget,
      onSlashCommand,
      onSubmitted,
      answerCommandLocally,
      sessionOptionsSurface: ptySessionOptionsSurface,
      trackPendingSend,
      setDraft,
      setCaret,
      clearSkillOrigin,
      clearImageAttachments,
      setNotice
    }
    const sendPty = useNativeChatPtyComposerSend({
      draftScopeKey,
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
    const { send: sendMessage, goalMode } = useNativeChatComposerSubmit({
      structuredTransport,
      draftScopeKey,
      draft,
      caret,
      imageAttachments,
      disabled,
      sendPty,
      sendStructured,
      consumeOrcaCommand: pending ? undefined : resume.consume,
      setDraft,
      setCaret
    })

    const { send, chooseEditItem, fieldOverrides, dispatchPickerCommand } =
      useNativeChatComposerEditSession({
        editSession,
        root,
        handle: localHandle,
        draftScopeKey,
        agent,
        disabled,
        sendHeld,
        ...picker,
        structuredTransport,
        sendStructured,
        ptyCommandRouting: { ...ptyCommandRouting, setActiveSuggestion },
        setNotice,
        sendMessage
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
        : goalMode.interceptPick(resume.interceptPick(dispatchPickerCommand)),
      dismissPicker: dismiss,
      interrupt: editSession?.cancel ?? interrupt,
      send,
      hasAttachments: imageAttachments.length > 0,
      ...(!editSession && steerHead ? { steerHead } : {}),
      setActiveSuggestion,
      setDraft,
      setCaret
    })

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
          sendButtonDisabled={sendButtonDisabled}
          sendBlockedReason={sendBlockedReason}
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
          onChoosePickerItem={goalMode.interceptPick(resume.interceptPick(completeItem))}
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
          sessionOptionsSurface={sessionOptionsSurface}
          sessionOptionsSnapshot={sessionOptionsSnapshot}
          contextUsage={contextUsageSummary}
          sessionOptionsPickerRequest={structuredTransport?.optionPickerRequest ?? null}
          agent={agent}
          {...fieldOverrides}
        />
      </div>
    )
  }
)

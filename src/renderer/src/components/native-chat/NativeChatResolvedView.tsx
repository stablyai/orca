import { cn } from '@/lib/utils'
import { NATIVE_CHAT_APPEARANCE_ROOT_CLASS } from './native-chat-appearance-style'
import { useNativeChatStoreAppearanceStyle } from './use-native-chat-store-appearance-style'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../store'
import { useNativeChatLaunchDraftSignal } from './use-native-chat-launch-draft-adoption'
import { useNativeChatRetainedSession } from './use-native-chat-retained-session'
import { isNativeChatTranscriptUnsettled } from './native-chat-live-session-contract'
import { selectNativeChatViewState } from './native-chat-view-state'
import { NativeChatMessageList } from './NativeChatMessageList'
import {
  useNativeChatInteractiveSendReveal,
  useNativeChatRevealLatest
} from './use-native-chat-reveal-latest'
import { useNativeChatLaunchPromptDeliveryNotice } from './use-native-chat-launch-prompt-delivery-notice'
import { NativeChatComposer, type NativeChatComposerHandle } from './NativeChatComposer'
import { useNativeChatFontSize } from './use-native-chat-font-size'
import { useNativeChatFind } from './use-native-chat-find'
import { NativeChatFindBar } from './NativeChatFindBar'
import { useNativeChatCanSend } from './use-native-chat-can-send'
import { NativeChatInteractiveCard } from './NativeChatInteractiveCard'
import { nativeChatAskRequiresTerminal } from '../../../../shared/native-chat-agent-support'
import { useNativeChatInteractivePromptCard } from './use-native-chat-interactive-prompt-card'
import { useNativeChatPromptCardPresentation } from './use-native-chat-prompt-card-presentation'
import { NativeChatPromptStrip } from './NativeChatPromptCollapse'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { useNativeChatInteractiveSend } from './use-native-chat-interactive-send'
import { shouldClearNativeChatWorkingSuppression } from '../../../../shared/native-chat/native-chat-working-suppression'
import { resolveNativeChatTerminalTurn } from '../../../../shared/native-chat/native-chat-terminal-turn'
import { useNativeChatTerminalTurnTiming } from './use-native-chat-terminal-turn-timing'
import { launchPromptAsMessage, shouldPruneLaunchPrompt } from './native-chat-pending'
import { pendingSendsAsMessages } from '../../../../shared/native-chat-pending-sends'
import { useNativeChatPendingDelivery } from './use-native-chat-pending-delivery'
import {
  appendCommandMarkerCache,
  applyCommandMarkerBoundaries,
  commandMarkersAsMessages,
  readCommandMarkerCache,
  type NativeChatCommandMarker
} from './native-chat-command-marker'
import {
  deriveNativeChatStreamingText,
  nativeChatStreamingMessage
} from '../../../../shared/native-chat/native-chat-streaming'
import { useNativeChatRootInputRouting } from './use-native-chat-root-input-routing'
import {
  emptyNativeChatContextMenuActions,
  useNativeChatContextMenu
} from './use-native-chat-context-menu'
import { createNativeChatRuntimeSelector } from './native-chat-runtime-owner'
import { useNativeChatPasteBridge } from './use-native-chat-paste-bridge'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import { useNativeChatLinkActions } from './use-native-chat-link-actions'
import type { NativeChatResolvedViewProps } from './native-chat-view-types'
import { useNativeChatFileLinkContext } from './use-native-chat-file-link-context'
import { useRecheckNativeChatFileLinksWhenTurnEnds } from './use-native-chat-file-link-existence'
import { useNativeChatLocalCommandAnswer } from './use-native-chat-local-command-answer'
import { matchNativeChatSplitShortcut } from './native-chat-split-shortcut'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { formatShortcutLabel } from '@/hooks/useShortcutLabel'

export function NativeChatResolvedView({
  paneKey,
  agent,
  sessionId,
  transcriptPath,
  isVisible,
  isFocusedGroup,
  targetPtyId,
  terminalTabId,
  ownsTabWideLaunchDraft,
  onSwitchToTerminal,
  readTerminalScreen,
  contextMenuActions
}: NativeChatResolvedViewProps): React.JSX.Element {
  // Route reads/subscriptions through the pane’s runtime owner; null retains local routing.
  const selectOwner = useMemo(() => createNativeChatRuntimeSelector(terminalTabId), [terminalTabId])
  const runtimeEnvironmentId = useAppStore(selectOwner)
  const keybindings = useAppStore((s) => s.keybindings)
  const session = useNativeChatRetainedSession({
    paneKey,
    agent,
    sessionId,
    transcriptPath,
    runtimeEnvironmentId,
    enabled: isVisible
  })
  const launchPrompt = useAppStore((s) => s.nativeChatLaunchPromptByTabId[terminalTabId] ?? null)
  const clearNativeChatLaunchPrompt = useAppStore((s) => s.clearNativeChatLaunchPrompt)
  const paneLaunchPrompt = launchPrompt?.agent === agent ? launchPrompt : null
  // Adopt the TUI’s unsent launch context into the GUI composer.
  const launchDraftSignal = useNativeChatLaunchDraftSignal({
    terminalTabId,
    agent,
    messages: session.messages,
    // Treat awaiting transcripts as unsettled to avoid re-offering an already-submitted prefill.
    transcriptLoading: isNativeChatTranscriptUnsettled(session.readPhase)
  })
  // Use the live session’s reconciled lifecycle for every working-state consumer.
  const liveWorking = session.status === 'working'
  // Preview the in-progress hook reply before its completed transcript turn arrives.
  const hookPreview = useAppStore((s) => s.agentStatusByPaneKey[paneKey]?.lastAssistantMessage)
  // Tool stdout/errors ride the same field for status-card previews; they are not the reply.
  const hookPreviewIsToolOutput = useAppStore(
    (s) => s.agentStatusByPaneKey[paneKey]?.lastAssistantMessageIsToolOutput === true
  )
  // A coalesced interrupt/restart can stay working; the newer epoch must still clear Stop suppression.
  const workingEpoch = useAppStore((s) => s.agentStatusByPaneKey[paneKey]?.stateStartedAt ?? null)
  const canSend = useNativeChatCanSend(targetPtyId)
  // Share verified composer delivery with prompt answers and ESC-based Stop.
  const send = useNativeChatInteractiveSend(paneKey, targetPtyId, agent)
  const { messageListRef, revealLatest } = useNativeChatRevealLatest()
  const interactiveSend = useNativeChatInteractiveSendReveal(send, targetPtyId, revealLatest)
  const [workingInterrupted, setWorkingInterrupted] = useState(false)
  const previousWorkingEpochRef = useRef<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<NativeChatComposerHandle>(null)
  // Keep Paste targeted while the question card replaces the composer.
  const questionAnswerInputRef = useRef<HTMLInputElement>(null)
  const fileLinkContext = useNativeChatFileLinkContext(terminalTabId)
  const onPaste = useNativeChatPasteBridge({ rootRef, composerRef, questionAnswerInputRef })

  // Keep optimistic echoes until their transcript turns land so sent messages never disappear during catch-up.
  const commandMarkerScope = useMemo(
    () => ({ paneKey, agent, sessionId }),
    [paneKey, agent, sessionId]
  )
  const delivery = useNativeChatPendingDelivery({ paneKey, agent, session })
  const { pending, record, clear } = delivery
  // Slash commands are local session-scoped feedback, not user turns; cap and cache their markers.
  const [commandMarkers, setCommandMarkers] = useState<NativeChatCommandMarker[]>(() =>
    readCommandMarkerCache(commandMarkerScope)
  )
  useEffect(() => {
    setCommandMarkers(readCommandMarkerCache(commandMarkerScope))
    setWorkingInterrupted(false)
  }, [commandMarkerScope])
  useEffect(() => {
    if (!paneLaunchPrompt || !shouldPruneLaunchPrompt(paneLaunchPrompt, session.messages)) {
      return
    }
    clearNativeChatLaunchPrompt(terminalTabId)
  }, [clearNativeChatLaunchPrompt, paneLaunchPrompt, session.messages, terminalTabId])
  const onOptimisticSend = useCallback(
    (text: string, imagePaths?: string[]) => {
      setWorkingInterrupted(false)
      return record(text, imagePaths)
    },
    [record]
  )
  const onSlashCommand = useCallback(
    (command: string, output?: string) => {
      setCommandMarkers(appendCommandMarkerCache(commandMarkerScope, command, Date.now(), output))
    },
    [commandMarkerScope]
  )

  const launchPromptMessage = useMemo(
    () => launchPromptAsMessage(paneLaunchPrompt, session.messages),
    [paneLaunchPrompt, session.messages]
  )
  const sessionWithLaunchPrompt = useMemo<typeof session>(() => {
    if (!launchPromptMessage) {
      return session
    }
    return { ...session, messages: [...session.messages, launchPromptMessage] }
  }, [launchPromptMessage, session])

  const sessionAfterCommandBoundaries = useMemo<typeof session>(() => {
    const messages = applyCommandMarkerBoundaries(sessionWithLaunchPrompt.messages, commandMarkers)
    return messages === sessionWithLaunchPrompt.messages
      ? sessionWithLaunchPrompt
      : { ...sessionWithLaunchPrompt, messages }
  }, [sessionWithLaunchPrompt, commandMarkers])
  // Why: answer from the conversation the pane shows, so a `/clear` sent here reads as reset.
  const answerLocally = useNativeChatLocalCommandAnswer(agent, sessionAfterCommandBoundaries)
  const launchPromptDeliveryNotices = useNativeChatLaunchPromptDeliveryNotice(
    paneLaunchPrompt?.failed ? launchPromptMessage?.id : null,
    sessionAfterCommandBoundaries.messages
  )
  // Why memoized: a fresh map each render would re-render every memoized transcript row.
  const deliveryNotices = useMemo(
    () =>
      delivery.notices.size === 0
        ? launchPromptDeliveryNotices
        : new Map([...(launchPromptDeliveryNotices ?? []), ...delivery.notices]),
    [launchPromptDeliveryNotices, delivery.notices]
  )
  const promptCard = useNativeChatInteractivePromptCard({
    paneKey,
    messages: sessionAfterCommandBoundaries.messages,
    transcriptSettled: session.readPhase === 'ready'
  })
  // A prompt card and composer must never share the input region: composer text would answer the agent’s selector.
  const promptCardPresentation = useNativeChatPromptCardPresentation({
    paneKey,
    targetPtyId,
    card: promptCard,
    canSend,
    transcriptSettled: session.readPhase === 'ready'
  })
  const { card: shownPromptCard, collapsedCard } = promptCardPresentation
  const mountedPromptCard = shownPromptCard ?? collapsedCard
  const rootInput = useNativeChatRootInputRouting({
    tabId: terminalTabId,
    rootRef,
    composerRef,
    questionAnswerInputRef,
    isVisible,
    isFocusedGroup,
    composerReady: shownPromptCard === null && targetPtyId !== null && canSend
  })

  // Match mobile ordering: hook preview before optimistic user echoes.
  const pendingMessages = useMemo(
    () => pendingSendsAsMessages(pending, sessionAfterCommandBoundaries.messages),
    [pending, sessionAfterCommandBoundaries.messages]
  )
  const streamingText = useMemo(() => {
    return deriveNativeChatStreamingText({
      messages:
        pendingMessages.length > 0
          ? [...sessionAfterCommandBoundaries.messages, ...pendingMessages]
          : sessionAfterCommandBoundaries.messages,
      previewText: hookPreview,
      working: liveWorking,
      previewIsToolOutput: hookPreviewIsToolOutput
    })
  }, [
    sessionAfterCommandBoundaries.messages,
    pendingMessages,
    hookPreview,
    liveWorking,
    hookPreviewIsToolOutput
  ])
  const sessionWithPending = useMemo<typeof session>(() => {
    if (pending.length === 0 && commandMarkers.length === 0 && !streamingText) {
      return sessionAfterCommandBoundaries
    }
    return {
      ...sessionAfterCommandBoundaries,
      messages: [
        ...sessionAfterCommandBoundaries.messages,
        ...commandMarkersAsMessages(commandMarkers),
        ...(streamingText ? [nativeChatStreamingMessage(streamingText)] : []),
        ...pendingMessages
      ]
    }
  }, [sessionAfterCommandBoundaries, pending, pendingMessages, commandMarkers, streamingText])
  // Include pending sends when selecting view state so the first echo leaves the empty screen immediately.
  const viewState = selectNativeChatViewState(sessionWithPending)

  const isConversation = viewState.kind === 'ready'
  useEffect(() => {
    if (
      shouldClearNativeChatWorkingSuppression({
        working: liveWorking,
        interrupted: workingInterrupted,
        workingEpoch,
        previousWorkingEpoch: previousWorkingEpochRef.current
      })
    ) {
      setWorkingInterrupted(false)
    }
    if (liveWorking && workingEpoch != null) {
      previousWorkingEpochRef.current = workingEpoch
    }
    if (!liveWorking) {
      previousWorkingEpochRef.current = null
    }
  }, [liveWorking, workingInterrupted, workingEpoch])
  const { isWorking, turnActive, awaitingInput } = resolveNativeChatTerminalTurn({
    isConversation,
    working: liveWorking,
    hookAwaitingInput: session.hookAwaitingInput === true,
    interrupted: workingInterrupted,
    hasPromptCard: promptCard !== null
  })
  const turnTiming = useNativeChatTerminalTurnTiming(paneKey, session.messages, turnActive)
  useRecheckNativeChatFileLinksWhenTurnEnds(turnActive)

  const stopAgent = useCallback(() => {
    setWorkingInterrupted(true)
    // Stop can outlive its delayed-write handle; clear cached echoes explicitly to prevent ghost prompts.
    clear()
    interactiveSend.cancel()
  }, [interactiveSend, clear])
  const { onLinkClick, linkActionRequest, closeLinkActions } = useNativeChatLinkActions(
    fileLinkContext,
    rootRef,
    { sessionId, isVisible }
  )

  useNativeChatFontSize(isConversation && isVisible && isFocusedGroup, rootRef)
  const find = useNativeChatFind(isVisible && isFocusedGroup, rootRef, composerRef, messageListRef)
  const contextMenu = useNativeChatContextMenu({
    rootRef,
    composerRef,
    enabled: isVisible,
    onSwitchToTerminal,
    splitShortcutLabels: {
      right: formatShortcutLabel('terminal.splitRight', keybindings),
      down: formatShortcutLabel('terminal.splitDown', keybindings)
    },
    actions: { onPaste, ...(contextMenuActions ?? emptyNativeChatContextMenuActions) },
    messageListRef,
    fileLinkContext,
    onFind: find.open
  })
  const appearanceStyle = useNativeChatStoreAppearanceStyle()

  return (
    <div
      ref={rootRef}
      data-native-chat-root="true"
      data-native-chat-working={isWorking ? 'true' : 'false'}
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        contextMenu.onPointerDownCapture(event)
        if (event.button === 2) {
          event.stopPropagation()
          return
        }
        rootInput.onPointerDownCapture(event)
      }}
      onKeyDownCapture={(event) => {
        find.onKeyDownCapture(event)
        const splitDirection = event.repeat
          ? null
          : matchNativeChatSplitShortcut(event, getShortcutPlatform(), keybindings)
        if (splitDirection && contextMenuActions) {
          event.preventDefault()
          event.stopPropagation()
          if (splitDirection === 'right') {
            contextMenuActions.onSplitRight()
          } else {
            contextMenuActions.onSplitDown()
          }
          return
        }
        rootInput.onKeyDownCapture(event)
      }}
      onContextMenuCapture={contextMenu.onContextMenuCapture}
      className={cn(
        NATIVE_CHAT_APPEARANCE_ROOT_CLASS,
        'flex h-full min-h-0 w-full flex-col focus:outline-none'
      )}
      style={appearanceStyle}
      data-native-chat-scheme={appearanceStyle.colorScheme}
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        {find.isOpen ? <NativeChatFindBar find={find} isVisible={isVisible} /> : null}
        {viewState.kind === 'loading' ? (
          <NativeChatEmptyState kind="loading" />
        ) : viewState.kind === 'error' ? (
          <NativeChatEmptyState kind="error" message={viewState.message} />
        ) : viewState.kind === 'empty' ? (
          <NativeChatEmptyState kind="empty" agent={agent} />
        ) : (
          <NativeChatMessageList
            ref={messageListRef}
            session={sessionWithPending}
            isVisible={isVisible}
            isWorking={turnActive}
            expandSignal={false}
            {...turnTiming}
            awaitingInput={awaitingInput}
            onLinkClick={onLinkClick}
            allowFileUriLinks={fileLinkContext !== null}
            deliveryNotices={deliveryNotices}
          />
        )}
      </div>
      {/* A collapsed card stays mounted but hidden, so a partly answered question survives. */}
      {mountedPromptCard ? (
        <div hidden={collapsedCard !== null} inert={collapsedCard !== null} className="contents">
          <NativeChatInteractiveCard
            key={promptCardPresentation.occurrenceKey ?? 'prompt'}
            card={mountedPromptCard}
            send={interactiveSend}
            requiresTerminal={nativeChatAskRequiresTerminal(agent)}
            onAnswerInTerminal={onSwitchToTerminal}
            onDismiss={promptCardPresentation.dismiss}
            onCollapse={promptCardPresentation.collapse}
            shouldFocus={shownPromptCard !== null && isVisible && isFocusedGroup}
            answerInputRef={questionAnswerInputRef}
          />
        </div>
      ) : null}
      {collapsedCard ? (
        <NativeChatPromptStrip card={collapsedCard} onExpand={promptCardPresentation.expand} />
      ) : null}
      {/* Honor mobile PTY ownership; retain the hidden composer’s state but detach its ref from typing, paste and focus routes. */}
      <div hidden={shownPromptCard !== null} className="contents">
        <NativeChatComposer
          ref={shownPromptCard ? undefined : composerRef}
          inputOwnedByCard={shownPromptCard !== null}
          terminalTabId={terminalTabId}
          paneKey={paneKey}
          targetPtyId={targetPtyId}
          agent={agent}
          canSend={canSend}
          isWorking={isWorking}
          onStop={stopAgent}
          onOptimisticSend={onOptimisticSend}
          onOptimisticSendCanceled={delivery.cancel}
          optimisticSendOutcome={delivery}
          onSlashCommand={onSlashCommand}
          onSubmitted={revealLatest}
          answerCommandLocally={answerLocally}
          onSwitchToTerminal={onSwitchToTerminal}
          readTerminalScreen={readTerminalScreen}
          launchSeed={{ ...launchDraftSignal, ownsTabWideLaunchDraft }}
          recallSource={{ messages: sessionWithPending.messages, commands: commandMarkers }}
        />
      </div>
      {contextMenu.menu}
      <LinkActionPopover request={linkActionRequest} onClose={closeLinkActions} />
    </div>
  )
}

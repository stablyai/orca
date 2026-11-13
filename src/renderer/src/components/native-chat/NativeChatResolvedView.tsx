import { useNativeChatDeliveryProjection } from './session/terminal/delivery/use-native-chat-delivery-projection'
import { NativeChatCrewFrame } from '../orchestration-crew/NativeChatCrewPanel'
import { TerminalChatCrewPanel } from '../orchestration-crew/TerminalChatCrewPanel'
import { cn } from '@/lib/class-names'
import { NATIVE_CHAT_APPEARANCE_ROOT_CLASS } from './appearance/native-chat-appearance-style'
import { useNativeChatStoreAppearanceStyle } from './appearance/use-native-chat-store-appearance-style'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../store/index'
import { useNativeChatLaunchDraftSignal } from './drafts/use-native-chat-launch-draft-adoption'
import { useNativeChatRetainedSession } from './session/terminal/read/use-native-chat-retained-session'
import { selectNativeChatViewState } from './session/status/native-chat-view-state'
import { NativeChatMessageList } from './NativeChatMessageList'
import {
  useNativeChatInteractiveSendReveal,
  useNativeChatRevealLatest
} from './messages/actions/use-native-chat-reveal-latest'
import { useNativeChatLaunchPromptDeliveryNotice } from './session/terminal/delivery/use-native-chat-launch-prompt-delivery-notice'
import { NativeChatComposer } from './composer/NativeChatComposer'
import type { NativeChatComposerHandle } from './composer/native-chat-composer-types'
import { useNativeChatFontSize } from './appearance/use-native-chat-font-size'
import { useNativeChatFind } from './viewport/find/use-native-chat-find'
import { NativeChatFindBar } from './viewport/find/NativeChatFindBar'
import { useNativeChatCanSend } from './host-access/use-native-chat-can-send'
import { NativeChatInteractiveCard } from './prompts/NativeChatInteractiveCard'
import { nativeChatAskRequiresTerminal } from '../../../../shared/native-chat/native-chat-agent-support'
import { useNativeChatTerminalPromptCard } from './prompts/use-native-chat-interactive-prompt-card'
import { NativeChatPromptStrip } from './prompts/NativeChatPromptCollapse'
import { NativeChatEmptyState } from './host-access/NativeChatEmptyState'
import { useNativeChatInteractiveSend } from './session/terminal/send/use-native-chat-interactive-send'
import { shouldClearNativeChatWorkingSuppression } from '../../../../shared/native-chat/native-chat-working-suppression'
import { resolveNativeChatTerminalTurn } from '../../../../shared/native-chat/native-chat-terminal-turn'
import { useNativeChatTerminalTurnTiming } from './conversation/turns/use-native-chat-terminal-turn-timing'
import { shouldPruneLaunchPrompt } from './session/terminal/delivery/native-chat-pending'
import { pendingSendsAsMessages } from '../../../../shared/native-chat/transcript/native-chat-pending-sends'
import {
  useNativeChatPendingDelivery,
  useNativeChatOptimisticSend
} from './session/terminal/delivery/use-native-chat-pending-delivery'
import {
  appendCommandMarkerCache,
  commandMarkersAsMessages,
  readCommandMarkerCache,
  type NativeChatCommandMarker
} from './session/terminal/delivery/native-chat-command-marker'
import {
  deriveNativeChatStreamingText,
  nativeChatStreamingMessage
} from '../../../../shared/native-chat/native-chat-streaming'
import { useNativeChatRootInputRouting } from './composer/focus/use-native-chat-root-input-routing'
import {
  emptyNativeChatContextMenuActions,
  useNativeChatContextMenu
} from './pane/actions/use-native-chat-context-menu'
import { createNativeChatRuntimeSelector } from './pane/ownership/native-chat-runtime-owner'
import { useNativeChatPasteBridge } from './paste/use-native-chat-paste-bridge'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import { useNativeChatLinkActions } from './links/actions/use-native-chat-link-actions'
import { NativeChatLinkClickContext } from './links/actions/native-chat-link-click-context'
import type { NativeChatResolvedViewProps } from './native-chat-view-types'
import { useNativeChatFileLinkContext } from './links/actions/use-native-chat-file-link-context'
import { useRecheckNativeChatFileLinksWhenTurnEnds } from './links/actions/use-native-chat-file-link-existence'
import { useNativeChatLocalCommandAnswer } from './session/options/terminal/use-native-chat-local-command-answer'
import { useNativeChatImageRuntimeContext } from './media/images/native-chat-image-runtime-context'
import { handleNativeChatPaneShortcut } from './pane/routing/native-chat-pane-shortcut'
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
  readTerminalDraft,
  contextMenuActions
}: NativeChatResolvedViewProps): React.JSX.Element {
  // Route reads/subscriptions through the pane’s runtime owner; null retains local routing.
  const selectOwner = useMemo(() => createNativeChatRuntimeSelector(terminalTabId), [terminalTabId])
  const runtimeEnvironmentId = useAppStore(selectOwner)
  const keybindings = useAppStore((s) => s.keybindings)
  const imageRuntimeContext = useNativeChatImageRuntimeContext(terminalTabId)
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
  const launchDraftSignal = useNativeChatLaunchDraftSignal({ terminalTabId, agent, session })
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
  const turnEpoch = useAppStore((s) => s.agentStatusByPaneKey[paneKey]?.turnStartedAt ?? null)
  const sendWorkingEpoch =
    (session.hookWorking ?? liveWorking) || session.hookAwaitingInput ? turnEpoch : undefined
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
  const questionAnswerInputRef = useRef<HTMLTextAreaElement>(null)
  const fileLinkContext = useNativeChatFileLinkContext(terminalTabId)
  const onPaste = useNativeChatPasteBridge({ rootRef, composerRef, questionAnswerInputRef })

  // Keep optimistic echoes until their transcript turns land so sent messages never disappear during catch-up.
  const commandMarkerScope = useMemo(
    () => ({ paneKey, agent, sessionId }),
    [paneKey, agent, sessionId]
  )
  const delivery = useNativeChatPendingDelivery({
    paneKey,
    agent,
    session,
    composerRef,
    workingEpoch: sendWorkingEpoch
  })
  const { pending, record, clear } = delivery
  // Slash commands are local session-scoped feedback, not user turns; cap and cache their markers.
  const [commandMarkers, setCommandMarkers] = useState<NativeChatCommandMarker[]>(() =>
    readCommandMarkerCache(commandMarkerScope)
  )
  const [prevCommandMarkerScope, setPrevCommandMarkerScope] = useState(commandMarkerScope)
  if (prevCommandMarkerScope !== commandMarkerScope) {
    setPrevCommandMarkerScope(commandMarkerScope)
    setCommandMarkers(readCommandMarkerCache(commandMarkerScope))
    setWorkingInterrupted(false)
  }
  useEffect(() => {
    if (!paneLaunchPrompt || !shouldPruneLaunchPrompt(paneLaunchPrompt, session.messages)) {
      return
    }
    clearNativeChatLaunchPrompt(terminalTabId)
  }, [clearNativeChatLaunchPrompt, paneLaunchPrompt, session.messages, terminalTabId])
  const onOptimisticSend = useNativeChatOptimisticSend(record, setWorkingInterrupted)
  const onSlashCommand = useCallback(
    (command: string, output?: string) => {
      setCommandMarkers(appendCommandMarkerCache(commandMarkerScope, command, Date.now(), output))
    },
    [commandMarkerScope]
  )

  const { launchPromptMessage, sessionAfterCommandBoundaries } = useNativeChatDeliveryProjection(
    paneLaunchPrompt,
    session,
    commandMarkers
  )
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
  const {
    promptCard,
    presentation: promptCardPresentation,
    actionKey
  } = useNativeChatTerminalPromptCard({
    paneKey,
    targetPtyId,
    runtimeEnvironmentId,
    agent,
    sessionId,
    transcriptPath: transcriptPath ?? null,
    messages: sessionAfterCommandBoundaries.messages,
    transcriptSettled: session.readPhase === 'ready',
    canSend
  })
  const { card: shownPromptCard, collapsedCard } = promptCardPresentation
  const mountedPromptCard = shownPromptCard ?? collapsedCard
  const composerReady = shownPromptCard === null && targetPtyId !== null && canSend
  const rootInput = useNativeChatRootInputRouting({
    tabId: terminalTabId,
    rootRef,
    composerRef,
    questionAnswerInputRef,
    isVisible,
    isFocusedGroup,
    composerReady
  })

  const pendingMessages = useMemo(
    () => pendingSendsAsMessages(pending, sessionAfterCommandBoundaries.messages, sendWorkingEpoch),
    [pending, sessionAfterCommandBoundaries.messages, sendWorkingEpoch]
  )
  const messagesWithPending = useMemo(
    () =>
      pendingMessages.length === 0
        ? sessionAfterCommandBoundaries.messages
        : [...sessionAfterCommandBoundaries.messages, ...pendingMessages],
    [sessionAfterCommandBoundaries.messages, pendingMessages]
  )
  const streamingText = useMemo(() => {
    return deriveNativeChatStreamingText({
      messages: messagesWithPending,
      previewText: hookPreview,
      working: liveWorking,
      previewIsToolOutput: hookPreviewIsToolOutput
    })
  }, [messagesWithPending, hookPreview, liveWorking, hookPreviewIsToolOutput])
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

  const root = (
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
        if (handleNativeChatPaneShortcut(event, keybindings, contextMenuActions)) {
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
      <NativeChatCrewFrame
        panel={
          <TerminalChatCrewPanel
            {...{ terminalTabId, paneKey, targetPtyId, isVisible, composerRef }}
            canMention={composerReady}
          />
        }
      >
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
            deliveryNotices={deliveryNotices}
            runtimeContext={imageRuntimeContext}
          />
        )}
      </NativeChatCrewFrame>
      {/* A collapsed card stays mounted but hidden, so a partly answered question survives. */}
      {mountedPromptCard ? (
        <div hidden={collapsedCard !== null} inert={collapsedCard !== null} className="contents">
          <NativeChatInteractiveCard
            key={actionKey}
            card={mountedPromptCard}
            send={interactiveSend}
            requiresTerminal={nativeChatAskRequiresTerminal(agent)}
            onAnswerInTerminal={onSwitchToTerminal}
            onDismiss={promptCardPresentation.dismiss}
            onCollapse={
              mountedPromptCard?.kind === 'approval' && mountedPromptCard.approval.startupDialog
                ? undefined
                : promptCardPresentation.collapse
            }
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
          launchSeed={{ ...launchDraftSignal, ownsTabWideLaunchDraft, readTerminalDraft }}
          recallSource={{ messages: sessionWithPending.messages, commands: commandMarkers }}
          conversationId={sessionId}
        />
      </div>
      {contextMenu.menu}
      <LinkActionPopover request={linkActionRequest} onClose={closeLinkActions} />
    </div>
  )
  return <NativeChatLinkClickContext value={onLinkClick}>{root}</NativeChatLinkClickContext>
}

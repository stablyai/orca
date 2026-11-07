import { NativeChatPaneFileDropScope } from './NativeChatPaneFileDropSurface'
import { NativeChatCrewFrame } from '../orchestration-crew/NativeChatCrewPanel'
import { TerminalChatCrewPanel } from '../orchestration-crew/TerminalChatCrewPanel'
import { cn } from '@/lib/utils'
import { NATIVE_CHAT_APPEARANCE_ROOT_CLASS } from './native-chat-appearance-style'
import { useNativeChatStoreAppearanceStyle } from './use-native-chat-store-appearance-style'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../store'
import { useNativeChatLaunchDraftSignal } from './use-native-chat-launch-draft-adoption'
import { useNativeChatRetainedSession } from './use-native-chat-retained-session'
import { selectNativeChatViewState } from './native-chat-view-state'
import { NativeChatMessageList } from './NativeChatMessageList'
import { NativeChatChildTranscriptStack } from './NativeChatChildTranscript'
import type { NativeChatMessageListHandle } from './use-native-chat-reveal-latest'
import {
  NativeChatChildNavigationContext,
  useNativeChatChildNavigator
} from './native-chat-child-navigation'
import {
  useNativeChatInteractiveSendReveal,
  useNativeChatRevealLatest
} from './use-native-chat-reveal-latest'
import { NativeChatComposer, type NativeChatComposerHandle } from './NativeChatComposer'
import { useNativeChatFontSize } from './use-native-chat-font-size'
import { useNativeChatFind } from './use-native-chat-find'
import { NativeChatFindBar } from './NativeChatFindBar'
import { useNativeChatCanSend } from './use-native-chat-can-send'
import { NativeChatInteractiveCard } from './NativeChatInteractiveCard'
import { nativeChatAskRequiresTerminal } from '../../../../shared/native-chat/native-chat-agent-support'
import { useNativeChatTerminalPromptCard } from './use-native-chat-interactive-prompt-card'
import { NativeChatPromptStrip } from './NativeChatPromptCollapse'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { useNativeChatInteractiveSend } from './use-native-chat-interactive-send'
import { shouldClearNativeChatWorkingSuppression } from '../../../../shared/native-chat/native-chat-working-suppression'
import { resolveNativeChatTerminalTurn } from '../../../../shared/native-chat/native-chat-terminal-turn'
import { useNativeChatTerminalTurnTiming } from './use-native-chat-terminal-turn-timing'
import { shouldPruneLaunchPrompt } from './native-chat-pending'
import {
  useNativeChatPendingDelivery,
  useNativeChatOptimisticSend
} from './use-native-chat-pending-delivery'
import {
  appendCommandMarkerCache,
  readCommandMarkerCache,
  type NativeChatCommandMarker
} from './native-chat-command-marker'
import { useNativeChatTerminalTranscript } from './use-native-chat-terminal-transcript'
import { useNativeChatRootInputRouting } from './use-native-chat-root-input-routing'
import {
  emptyNativeChatContextMenuActions,
  useNativeChatContextMenu
} from './use-native-chat-context-menu'
import { createNativeChatRuntimeSelector } from './native-chat-runtime-owner'
import { useNativeChatPasteBridge } from './use-native-chat-paste-bridge'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import { useNativeChatLinkActions } from './use-native-chat-link-actions'
import { NativeChatLinkClickContext } from './native-chat-link-click-context'
import type { NativeChatResolvedViewProps } from './native-chat-view-types'
import { useNativeChatFileLinkContext } from './use-native-chat-file-link-context'
import { useRecheckNativeChatFileLinksWhenTurnEnds } from './use-native-chat-file-link-existence'
import { useNativeChatImageRuntimeContext } from './native-chat-image-runtime-context'
import { handleNativeChatPaneShortcut } from './native-chat-pane-shortcut'
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
  const childMessageListRef = useRef<NativeChatMessageListHandle>(null)
  // Route reads/subscriptions through the pane’s runtime owner; null retains local routing.
  const selectOwner = useMemo(() => createNativeChatRuntimeSelector(terminalTabId), [terminalTabId])
  const runtimeEnvironmentId = useAppStore(selectOwner)
  const childNavigator = useNativeChatChildNavigator(
    JSON.stringify([paneKey, runtimeEnvironmentId, sessionId])
  )
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
  const readOnlyComposerRef = useRef<NativeChatComposerHandle>(null)
  const activeComposerRef = childNavigator.child ? readOnlyComposerRef : composerRef
  // Keep Paste targeted while the question card replaces the composer.
  const questionAnswerInputRef = useRef<HTMLTextAreaElement>(null)
  const readOnlyQuestionAnswerInputRef = useRef<HTMLTextAreaElement>(null)
  const activeQuestionAnswerInputRef = childNavigator.child
    ? readOnlyQuestionAnswerInputRef
    : questionAnswerInputRef
  const fileLinkContext = useNativeChatFileLinkContext(terminalTabId)
  const onPaste = useNativeChatPasteBridge({
    rootRef,
    composerRef: activeComposerRef,
    questionAnswerInputRef: activeQuestionAnswerInputRef
  })

  // Keep optimistic echoes until their transcript turns land so sent messages never disappear during catch-up.
  const commandMarkerScope = useMemo(
    () => ({ paneKey, agent, sessionId }),
    [paneKey, agent, sessionId]
  )
  const { clear: clearDelivery, ...delivery } = useNativeChatPendingDelivery({
    paneKey,
    agent,
    session,
    composerRef,
    workingEpoch: sendWorkingEpoch
  })
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
  const onOptimisticSend = useNativeChatOptimisticSend(delivery.record, setWorkingInterrupted)
  const onSlashCommand = useCallback(
    (command: string, output?: string) => {
      setCommandMarkers(appendCommandMarkerCache(commandMarkerScope, command, Date.now(), output))
    },
    [commandMarkerScope]
  )

  const { answerLocally, deliveryNotices, sessionAfterCommandBoundaries, sessionWithPending } =
    useNativeChatTerminalTranscript({
      session,
      launchPrompt: paneLaunchPrompt,
      agent,
      commandMarkers,
      delivery,
      workingEpoch: sendWorkingEpoch,
      previewText: hookPreview,
      working: liveWorking,
      previewIsToolOutput: hookPreviewIsToolOutput
    })
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
    composerRef: activeComposerRef,
    questionAnswerInputRef: activeQuestionAnswerInputRef,
    isVisible,
    isFocusedGroup,
    composerReady: composerReady && childNavigator.child === null
  })

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
    clearDelivery()
    interactiveSend.cancel()
  }, [interactiveSend, clearDelivery])
  const { onLinkClick, linkActionRequest, closeLinkActions } = useNativeChatLinkActions(
    fileLinkContext,
    rootRef,
    { sessionId, isVisible }
  )

  useNativeChatFontSize(isConversation && isVisible && isFocusedGroup, rootRef)
  const find = useNativeChatFind(
    isVisible && isFocusedGroup,
    rootRef,
    activeComposerRef,
    childNavigator.child ? childMessageListRef : messageListRef
  )
  const contextMenu = useNativeChatContextMenu({
    rootRef,
    composerRef: activeComposerRef,
    enabled: isVisible,
    onSwitchToTerminal,
    splitShortcutLabels: {
      right: formatShortcutLabel('terminal.splitRight', keybindings),
      down: formatShortcutLabel('terminal.splitDown', keybindings)
    },
    actions: { onPaste, ...(contextMenuActions ?? emptyNativeChatContextMenuActions) },
    messageListRef: childNavigator.child ? childMessageListRef : messageListRef,
    fileLinkContext,
    onFind: find.open
  })
  const appearanceStyle = useNativeChatStoreAppearanceStyle()

  const root = (
    <NativeChatChildNavigationContext.Provider value={childNavigator.navigation}>
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
        {find.isOpen ? <NativeChatFindBar find={find} isVisible={isVisible} /> : null}
        <NativeChatPaneFileDropScope
          enabled={childNavigator.child === null}
          hidden={childNavigator.child !== null}
          inert={childNavigator.child !== null}
          className={childNavigator.child ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}
        >
          <NativeChatCrewFrame
            panel={
              <TerminalChatCrewPanel
                {...{ terminalTabId, paneKey, targetPtyId, composerRef }}
                isVisible={isVisible && childNavigator.child === null}
                canMention={composerReady && childNavigator.child === null}
              />
            }
          >
            <div className="relative flex min-h-0 flex-1 flex-col">
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
                  isVisible={isVisible && childNavigator.child === null}
                  isWorking={turnActive}
                  expandSignal={false}
                  {...turnTiming}
                  awaitingInput={awaitingInput}
                  deliveryNotices={deliveryNotices}
                  runtimeContext={imageRuntimeContext}
                />
              )}
            </div>
          </NativeChatCrewFrame>
          {/* A collapsed card stays mounted but hidden, so a partly answered question survives. */}
          {mountedPromptCard ? (
            <div
              hidden={collapsedCard !== null}
              inert={collapsedCard !== null}
              className="contents"
            >
              <NativeChatInteractiveCard
                key={actionKey}
                card={mountedPromptCard}
                send={interactiveSend}
                requiresTerminal={nativeChatAskRequiresTerminal(agent)}
                onAnswerInTerminal={onSwitchToTerminal}
                onDismiss={promptCardPresentation.dismiss}
                onCollapse={promptCardPresentation.collapse}
                shouldFocus={
                  shownPromptCard !== null &&
                  isVisible &&
                  isFocusedGroup &&
                  childNavigator.child === null
                }
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
            />
          </div>
        </NativeChatPaneFileDropScope>
        {childNavigator.child ? (
          <NativeChatChildTranscriptStack
            messageListRef={childMessageListRef}
            path={childNavigator.path}
            onBack={childNavigator.back}
            session={sessionWithPending}
            isVisible={isVisible}
            onLinkClick={onLinkClick}
            runtimeContext={imageRuntimeContext}
          />
        ) : null}
        {contextMenu.menu}
        <LinkActionPopover request={linkActionRequest} onClose={closeLinkActions} />
      </div>
    </NativeChatChildNavigationContext.Provider>
  )
  return <NativeChatLinkClickContext value={onLinkClick}>{root}</NativeChatLinkClickContext>
}

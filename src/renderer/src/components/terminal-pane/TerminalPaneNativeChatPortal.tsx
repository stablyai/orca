import { createPortal } from 'react-dom'
import NativeChatView from '../native-chat/NativeChatView'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { canContinueAgentSessionInNewSession } from './terminal-agent-session-continuation'
import type { TerminalPaneController } from './use-terminal-pane-controller'
import { useAppStore } from '@/store'
import { resolvePaneAgentSessionId } from './pane-agent-session-id'

export function TerminalPaneNativeChatPortal({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element | null {
  const {
    chatPane,
    chatPaneLaunchAgent,
    chatPaneOwnsTabWideLaunchDraft,
    chatPanePtyId,
    chatPaneResolvedAgent,
    chatPaneDispatchStatus,
    contextMenu,
    effectiveChatViewMode,
    expandedPaneId,
    isRendererVisible,
    managedPanes,
    readNativeChatTerminalScreen,
    resolveAgentForLeaf,
    structuredChatAgent,
    structuredChatTarget,
    structuredSessionId,
    switchNativeChatToTerminal,
    tabId,
    unifiedTabId
  } = controller
  const chatPaneSessionId = useAppStore((state) =>
    effectiveChatViewMode && chatPane
      ? resolvePaneAgentSessionId(state, makePaneKey(tabId, chatPane.leafId))
      : null
  )
  if (!effectiveChatViewMode || !chatPane?.container) {
    return null
  }

  return createPortal(
    <div className="native-chat-pane-shell absolute inset-0 z-10 flex min-h-0 min-w-0 bg-background">
      {structuredSessionId && structuredChatAgent ? (
        <NativeChatView
          mode="structured"
          tabId={unifiedTabId ?? tabId}
          sessionId={structuredSessionId}
          agent={structuredChatAgent}
          isVisible={isRendererVisible}
          target={structuredChatTarget}
          allowFileUriLinks
          orchestrationDispatchStatus={chatPaneDispatchStatus}
        />
      ) : (
        <NativeChatView
          terminalTabId={tabId}
          isVisible={isRendererVisible}
          paneKey={makePaneKey(tabId, chatPane.leafId)}
          targetPtyId={chatPanePtyId}
          launchAgent={chatPaneLaunchAgent}
          resolvedAgent={chatPaneResolvedAgent}
          ownsTabWideLaunchDraft={chatPaneOwnsTabWideLaunchDraft}
          onSwitchToTerminal={switchNativeChatToTerminal}
          readTerminalScreen={readNativeChatTerminalScreen}
          contextMenuActions={{
            onSplitRight: () => contextMenu.runForPane(chatPane.id, contextMenu.onSplitRight),
            onSplitDown: () => contextMenu.runForPane(chatPane.id, contextMenu.onSplitDown),
            canEqualizePaneSizes: managedPanes.length > 1 && expandedPaneId === null,
            onEqualizePaneSizes: () =>
              contextMenu.runForPane(chatPane.id, contextMenu.onEqualizePaneSizes),
            canExpandPane: managedPanes.length > 1,
            isPaneExpanded: expandedPaneId === chatPane.id,
            onToggleExpand: () => contextMenu.runForPane(chatPane.id, contextMenu.onToggleExpand),
            canContinueAgentSessionInNewSession: canContinueAgentSessionInNewSession(
              resolveAgentForLeaf(chatPane.leafId)
            ),
            onContinueAgentSessionInNewSession: () =>
              contextMenu.runForPane(chatPane.id, contextMenu.onContinueAgentSessionInNewSession),
            onForkAgentSession: () =>
              void contextMenu.runForPane(chatPane.id, contextMenu.onForkAgentSession),
            onSetTitle: () => contextMenu.runForPane(chatPane.id, contextMenu.onSetTitle),
            onCopyTerminalId: () =>
              void contextMenu.runForPane(chatPane.id, contextMenu.onCopyTerminalId),
            onCopyPaneId: () => void contextMenu.runForPane(chatPane.id, contextMenu.onCopyPaneId),
            canCopyAgentSessionId: chatPaneSessionId !== null,
            onCopyAgentSessionId: () =>
              void contextMenu.runForPane(chatPane.id, contextMenu.onCopyAgentSessionId),
            canClosePane: managedPanes.length > 1,
            onClosePane: () => contextMenu.runForPane(chatPane.id, contextMenu.onClosePane)
          }}
          orchestrationDispatchStatus={chatPaneDispatchStatus}
        />
      )}
    </div>,
    chatPane.container,
    `native-chat-${tabId}-${chatPane.leafId}`
  )
}

// The host half of the chat gate (XLR-034), plus the confirmed-agent-exit route
// that consumes it. Split out of use-terminal-pane-chat-state.ts: both answer
// "may this leaf still own Chat?", and that file is at its line ratchet.

import { useCallback, useEffect } from 'react'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  nativeChatHostCanRenderLeafTranscript,
  nativeChatLaunchAgentForLeaf,
  resolveNativeChatLeafRoute
} from '../native-chat/native-chat-leaf-routing'
import type { TerminalPaneChatController } from './use-terminal-pane-chat-state'

export function useTerminalPaneChatHostRender(controller: TerminalPaneChatController) {
  const {
    applyNativeChatLeafRoute,
    chatLeafId,
    getNativeChatLeafIds,
    getTabWideAgentHintLeafId,
    isChatEligibleForLeaf,
    isChatViewMode,
    managerRef,
    nativeChatTranscriptIsLocalReadable,
    onAgentExitedRef,
    resolveTitleAgentForLeaf,
    structuredSessionAgent,
    structuredSessionId,
    tabAgentTypeByLeaf,
    terminalTab
  } = controller

  // The host half of the chat gate, asked for ONE leaf (XLR-034). The owning
  // leaf is retained across a Terminal<->Chat toggle, so the toggle back is
  // never re-gated by active-leaf eligibility — this is what still refuses a
  // leaf whose transcript moved to a host this renderer cannot read.
  const resolveChatLeafHostCanRender = useCallback(
    (leafId: string): boolean =>
      nativeChatHostCanRenderLeafTranscript({
        agent:
          tabAgentTypeByLeaf[leafId] ??
          nativeChatLaunchAgentForLeaf({
            launchAgent: terminalTab?.launchAgent,
            launchAgentLeafId: getTabWideAgentHintLeafId(),
            leafId,
            leafIds: getNativeChatLeafIds()
          }) ??
          (structuredSessionAgent as TuiAgent | null) ??
          resolveTitleAgentForLeaf(leafId),
        transcriptIsLocalReadable: nativeChatTranscriptIsLocalReadable
      }),
    [
      tabAgentTypeByLeaf,
      nativeChatTranscriptIsLocalReadable,
      structuredSessionAgent,
      terminalTab?.launchAgent,
      getNativeChatLeafIds,
      getTabWideAgentHintLeafId,
      resolveTitleAgentForLeaf
    ]
  )

  const handleConfirmedAgentExit = useCallback(
    (leafId: string): void => {
      if (leafId !== chatLeafId) {
        return
      }
      const panes = managerRef.current?.getPanes() ?? []
      const activeLeafId = managerRef.current?.getActivePane()?.leafId ?? null
      applyNativeChatLeafRoute(
        resolveNativeChatLeafRoute({
          isChatViewMode,
          chatLeafId,
          activeLeafId,
          chatLeafStillMounted: panes.some((pane) => pane.leafId === chatLeafId),
          activeLeafIsEligible: isChatEligibleForLeaf(activeLeafId),
          chatLeafHasConfirmedAgentExit: true,
          structuredSessionId,
          hostCanRenderTranscript: chatLeafId ? resolveChatLeafHostCanRender(chatLeafId) : undefined
        })
      )
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [
      applyNativeChatLeafRoute,
      chatLeafId,
      isChatEligibleForLeaf,
      isChatViewMode,
      resolveChatLeafHostCanRender,
      structuredSessionId
    ]
  )

  useEffect(() => {
    onAgentExitedRef.current = handleConfirmedAgentExit
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [handleConfirmedAgentExit])

  return { resolveChatLeafHostCanRender }
}

export type TerminalPaneChatHostRenderController = TerminalPaneChatController &
  ReturnType<typeof useTerminalPaneChatHostRender>

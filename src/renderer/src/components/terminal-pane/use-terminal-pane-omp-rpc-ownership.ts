// W6-2: RPC ownership (Decision 1) is anchored to this PANE's life, not to the
// Chat-view mount. Deliberately a controller stage rather than something inside
// the (un)mountable chat surface, so the identity used to acquire and hold
// ownership stays resolvable across an ordinary Terminal<->Chat toggle instead
// of vanishing whenever the chat portal unmounts.

import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { useOmpRpcChatPaneOwnership } from '../native-chat/use-omp-rpc-chat-pane-ownership'
import { useOmpRpcProbeCwd } from '../native-chat/use-omp-rpc-commands'
import {
  selectNativeChatPaneConnectionId,
  selectNativeChatProjectRuntime,
  selectNativeChatRuntimeEnvironmentId
} from '../native-chat/native-chat-runtime-owner'
import { resolveEffectiveChatPanePtyId } from '../native-chat/native-chat-effective-pty-id'
import type { TerminalPaneProjectionController } from './use-terminal-pane-projection'
import { resolveOmpRpcOwnerCwd } from './omp-rpc-owner-cwd'

export function useTerminalPaneOmpRpcOwnership(controller: TerminalPaneProjectionController): void {
  const {
    chatLeafId,
    effectiveChatViewMode,
    isRendererVisible,
    managedPanes,
    paneTransportsRef,
    resolveAgentForLeaf,
    savedLayout,
    tabId
  } = controller

  // Mirrors chatPane/chatPanePtyId in the projection, but UNGATED on
  // isChatViewMode — see this module's header.
  const chatOwnerPane = chatLeafId
    ? (managedPanes.find((pane) => pane.leafId === chatLeafId) ?? null)
    : null
  const chatOwnerPaneKey = chatOwnerPane ? makePaneKey(tabId, chatOwnerPane.leafId) : null
  // Wave 11: same transport/layout preference as chatPanePtyId — this value
  // also feeds useOmpRpcChatPaneOwnership's own `ptyId` (the acquire
  // kill-target), which must see a restored PTY the transport never learned
  // about, not just the composer.
  const chatOwnerPtyId = chatOwnerPane
    ? resolveEffectiveChatPanePtyId(
        paneTransportsRef.current.get(chatOwnerPane.id)?.getPtyId() ?? null,
        savedLayout.ptyIdsByLeafId?.[chatOwnerPane.leafId]
      )
    : null
  const chatOwnerAgent = resolveAgentForLeaf(chatOwnerPane?.leafId ?? null)
  const chatOwnerRuntimeEnvironmentId = useAppStore((s) =>
    selectNativeChatRuntimeEnvironmentId(s, tabId)
  )
  const chatOwnerProjectRuntime = useAppStore((s) => selectNativeChatProjectRuntime(s, tabId))
  // The runtime owner id alone is not a locality test — it is null for an
  // `ssh:` worktree too. Pair it with the pane's SSH owner so RPC acquisition
  // only ever engages a pane this client actually executes.
  const chatOwnerConnectionId = useAppStore((s) => selectNativeChatPaneConnectionId(s, tabId))
  const chatOwnerProbeCwd = useOmpRpcProbeCwd(chatOwnerAgent, tabId)
  const chatOwnerCwd = chatOwnerPane
    ? resolveOmpRpcOwnerCwd({
        paneId: chatOwnerPane.id,
        paneCwdMap: controller.paneCwdRef.current,
        fallbackCwd: chatOwnerProbeCwd
      })
    : null
  // The trigger for the FIRST acquisition only — the hook's own F9 latch holds
  // ownership once acquired regardless of this later going false on an ordinary
  // Terminal<->Chat toggle or the tab backgrounding.
  const chatOwnerIsVisible = Boolean(effectiveChatViewMode && chatOwnerPane && isRendererVisible)
  useOmpRpcChatPaneOwnership({
    agent: chatOwnerAgent,
    paneKey: chatOwnerPaneKey,
    ptyId: chatOwnerPtyId,
    cwd: chatOwnerCwd,
    isVisible: chatOwnerIsVisible,
    runtimeEnvironmentId: chatOwnerRuntimeEnvironmentId,
    projectRuntime: chatOwnerProjectRuntime,
    connectionId: chatOwnerConnectionId
  })
}

export function TerminalPaneOmpRpcOwnershipMount({
  controller
}: {
  controller: TerminalPaneProjectionController
}): null {
  useTerminalPaneOmpRpcOwnership(controller)
  return null
}

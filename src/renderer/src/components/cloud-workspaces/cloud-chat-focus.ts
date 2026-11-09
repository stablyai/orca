// Store-bound side of cloud chat ids: which chat this device has in front, and bringing a chat
// (from a link or a teammate being followed) to the front once its tab has synced here.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { activateStructuredAgentSessionById } from '@/lib/agent-session/structured-agent-session-tab-activation'
import { activateTabAndFocusPane } from '@/lib/workspace/tabs/activate-tab-and-focus-pane'
import { activateTerminalTabOnOwner } from '@/lib/workspace/tabs/terminal-tab-owner-activation'
import { getRemoteRuntimeTerminalHandle } from '@/runtime/hosted-terminals/identity/remote-runtime-pty-owner'
import {
  cloudChatIdForTab,
  findCloudChatTarget,
  parseCloudChatId,
  type CloudChatTarget
} from './cloud-chat-id'

/** Tabs of a just-opened workspace arrive from its server shortly after; wait this long for them. */
const FOCUS_WAIT_MS = 8_000
const FOCUS_RETRY_MS = 250

/** The shareable id of the chat in front of this worktree, or null (editor, browser, local PTY…). */
export function currentCloudChatId(worktreeId: string): string | null {
  const state = useAppStore.getState()
  const tab = state.getActiveTab(worktreeId)
  return cloudChatIdForTab(
    tab,
    tab ? state.terminalLayoutsByTabId[tab.entityId] : undefined,
    getRemoteRuntimeTerminalHandle
  )
}

/**
 * Searches the preferred worktree first, then every other one: a chat can sit in any worktree of
 * the workspace's server, not only the one that opening it revealed.
 */
function findTarget(
  preferredWorktreeId: string | null,
  chatId: string
): { worktreeId: string; target: CloudChatTarget } | null {
  const ref = parseCloudChatId(chatId)
  if (!ref) {
    return null
  }
  const state = useAppStore.getState()
  const others = Object.keys(state.unifiedTabsByWorktree).filter((id) => id !== preferredWorktreeId)
  for (const worktreeId of preferredWorktreeId ? [preferredWorktreeId, ...others] : others) {
    const target = findCloudChatTarget(
      ref,
      state.unifiedTabsByWorktree[worktreeId] ?? [],
      (tab) => state.terminalLayoutsByTabId[tab.entityId],
      getRemoteRuntimeTerminalHandle
    )
    if (target) {
      return { worktreeId, target }
    }
  }
  return null
}

function activate(worktreeId: string, target: CloudChatTarget): boolean {
  if (useAppStore.getState().activeWorktreeId !== worktreeId) {
    activateAndRevealWorktree(worktreeId)
  }
  if (target.kind === 'session') {
    return activateStructuredAgentSessionById({ worktreeId, sessionId: target.sessionId })
  }
  const state = useAppStore.getState()
  const { tab, leafId } = target
  state.focusGroup(worktreeId, tab.groupId)
  state.activateTab(tab.id, { worktreeId })
  // Activating the leaf hands it focus (a chat leaf passes it to its composer).
  activateTabAndFocusPane(tab.entityId, leafId, { collapseExpandedPane: true })
  activateTerminalTabOnOwner(worktreeId, tab.entityId, leafId)
  return true
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Brings a chat to the front, waiting briefly for its tab to sync; tells the user if it is gone. */
export async function focusCloudChat(
  preferredWorktreeId: string | null,
  chatId: string,
  waitMs = FOCUS_WAIT_MS
): Promise<boolean> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const found = findTarget(preferredWorktreeId, chatId)
    if (found && activate(found.worktreeId, found.target)) {
      return true
    }
    if (Date.now() >= deadline) {
      break
    }
    await sleep(FOCUS_RETRY_MS)
  }
  toast.message(
    translate(
      'auto.components.cloudWorkspaces.chatGone',
      'That chat is no longer open in this workspace. Showing the workspace instead.'
    )
  )
  return false
}

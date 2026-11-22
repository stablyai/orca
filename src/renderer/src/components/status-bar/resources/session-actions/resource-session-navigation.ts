import { parsePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { collectLeafIds } from '../../../../../../shared/workspace-layout/terminal-topology/terminal-pane-layout-tree'
import type { TerminalLayoutSnapshot } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { toast } from 'sonner'
import { parseExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { activateAiVaultStructuredSession } from '@/lib/agent-session/open/activate-ai-vault-structured-session'
import { BotGroupRoomUnavailableError } from '@/lib/bot-group-catalog'

type TabLookup = Record<string, { id: string }[]>

export type ResourceSessionNavigationDeps = {
  tabsByWorktree: TabLookup
  /** Current pane layouts; a restored terminal's recorded pane may no longer exist in its tab. */
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>
  setActiveView: (view: 'terminal') => void
  activateAndRevealWorktree: (worktreeId: string) => unknown
  activateTabAndFocusPane: (
    tabId: string,
    leafId: string | null,
    opts: { flashFocusedPane: true; scrollToBottomIfOutputSinceLastView: true }
  ) => void
}

export function isResourceSessionActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' '
}

export function navigateResourceSessionToTab(
  tabId: string,
  paneKey: string | null,
  deps: ResourceSessionNavigationDeps
): void {
  for (const [worktreeId, tabs] of Object.entries(deps.tabsByWorktree)) {
    if (tabs.some((tab) => tab.id === tabId)) {
      deps.activateAndRevealWorktree(worktreeId)
      break
    }
  }

  // Always reveal terminal view because stale tab mappings can bypass the workspace navigation that normally switches it.
  deps.setActiveView('terminal')

  // Stable leaf UUIDs identify panes; legacy numeric keys, and a pane the tab no longer has, fall back to tab activation.
  const parsed = paneKey ? parsePaneKey(paneKey) : null
  const leafId =
    parsed?.tabId === tabId &&
    collectLeafIds(deps.terminalLayoutsByTabId[tabId]?.root).includes(parsed.leafId)
      ? parsed.leafId
      : null
  deps.activateTabAndFocusPane(tabId, leafId, {
    flashFocusedPane: true,
    scrollToBottomIfOutputSinceLastView: true
  })
}

/** Opens a chat row the way a history click does: a background chat is revealed, a group member opens its room. */
export function openResourceChat(
  worktreeId: string,
  agentSessionId: string,
  /** The paired host that sampled the row; without one, this machine sampled it. A same-id twin never takes the open. */
  runtimeHostId?: string
): Promise<unknown> {
  const host = parseExecutionHostId(runtimeHostId)
  // Openers toast their own outcomes; only a thrown message, such as a missing group room, reaches here.
  return activateAiVaultStructuredSession(
    { structuredSession: { workspaceId: worktreeId, sessionId: agentSessionId } },
    undefined,
    host?.kind === 'runtime'
      ? { kind: 'environment', environmentId: host.environmentId }
      : { kind: 'local' }
  ).catch((error: unknown) => {
    if (!(error instanceof BotGroupRoomUnavailableError && error.userNotified)) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  })
}

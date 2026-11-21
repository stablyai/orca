import { parsePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { toast } from 'sonner'
import { parseExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { activateAiVaultStructuredSession } from '@/lib/agent-session/open/activate-ai-vault-structured-session'
import { BotGroupRoomUnavailableError } from '@/lib/bot-group-catalog'

type TabLookup = Record<string, { id: string }[]>

export type ResourceSessionNavigationDeps = {
  tabsByWorktree: TabLookup
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

  // Stable leaf UUIDs identify panes; legacy numeric keys fall back to tab activation instead of guessing.
  const parsed = paneKey ? parsePaneKey(paneKey) : null
  deps.activateTabAndFocusPane(tabId, parsed?.tabId === tabId ? parsed.leafId : null, {
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
): void {
  const host = parseExecutionHostId(runtimeHostId)
  // Openers toast their own outcomes; only a thrown message, such as a missing group room, reaches here.
  void activateAiVaultStructuredSession(
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

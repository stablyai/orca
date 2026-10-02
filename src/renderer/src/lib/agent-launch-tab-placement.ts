/**
 * Where the tab of an agent the host launches lands, and that it takes focus as it appears.
 *
 * The caller mints the pane (and, for Claude or Codex, the chat session) before it asks, because
 * the host decides whether the launch runs as a terminal or a chat and reveals the tab before the
 * reply, which can wait up to a minute on the prompt. One reservation under both ids holds the
 * group: the local terminal reveal reads it by the pane's tab id, and the session-tabs mirror reads
 * it by the chat's tab id. A paired host's terminal is placed by a recorded placement, and the
 * mirror focuses a tab only by a recorded focus intent.
 */

import { useAppStore } from '@/store'
import {
  reserveAgentLaunchTab,
  type AgentLaunchTabReveal
} from '@/lib/agent-launch-tab-reservations'
import {
  clearWebSessionFocusIntentIfMatches,
  recordWebSessionFocusIntent,
  resolveWebSessionVisibleTabId
} from '@/runtime/web-session-focus-intent'
import {
  forgetWebSessionTerminalPlacement,
  recordWebSessionTerminalPlacement
} from '@/runtime/web-session-terminal-placement'
import { settleWebRuntimeTerminalPlacement } from '@/runtime/web-runtime-terminal-placement-settlement'
import { refreshWebRuntimeSessionTabsSnapshot } from '@/runtime/web-runtime-session-snapshot'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '@/runtime/local-structured-session-owner'
import type { AgentLaunchResult } from '../../../shared/agent-launch-intent'

export type AgentLaunchTabPlacementArgs = {
  target: RuntimeClientTarget
  worktreeId: string
  groupId?: string
  tabId: string
  leafId: string
  /** The chat session the launch names, when the agent can run as one. */
  sessionId?: string
  /** The terminal's tab exists; the local reveal is the only one that can say so before the reply. */
  onRevealed: (reveal: AgentLaunchTabReveal) => void
}

export type AgentLaunchTabPlacement = {
  /** The launch settled; `result` is null when it failed or its outcome is unknown. */
  settle(result: AgentLaunchResult | null): void
}

function chatHostTabId(sessionId: string): string {
  return `agent-session:${sessionId}`
}

/** Every id the launch's tab can arrive as: the terminal's pane tab, or the chat's session tab. */
function launchTabIds(tabId: string, sessionId: string | undefined): string[] {
  return sessionId ? [tabId, chatHostTabId(sessionId)] : [tabId]
}

export function placeAgentLaunchTab(args: AgentLaunchTabPlacementArgs): AgentLaunchTabPlacement {
  return args.target.kind === 'local'
    ? placeLocalLaunchTab(args)
    : placePairedLaunchTab(args, args.target.environmentId)
}

function placeLocalLaunchTab(args: AgentLaunchTabPlacementArgs): AgentLaunchTabPlacement {
  const release = reserveAgentLaunchTab(launchTabIds(args.tabId, args.sessionId), {
    worktreeId: args.worktreeId,
    ...(args.groupId ? { groupId: args.groupId } : {}),
    onRevealed: args.onRevealed
  })
  // Why: the mirror focuses only a tab the client asked for; the terminal reveal focuses its own.
  const owner = { environmentId: LOCAL_STRUCTURED_SESSION_OWNER }
  const chatTabId = args.sessionId ? chatHostTabId(args.sessionId) : null
  if (chatTabId) {
    recordWebSessionFocusIntent(
      owner,
      args.worktreeId,
      chatTabId,
      undefined,
      resolveWebSessionVisibleTabId(useAppStore.getState(), args.worktreeId)
    )
  }
  return {
    settle: (result) => {
      release()
      if (chatTabId && result?.outcome.kind !== 'structured') {
        clearWebSessionFocusIntentIfMatches(owner, args.worktreeId, chatTabId)
      }
    }
  }
}

function placePairedLaunchTab(
  args: AgentLaunchTabPlacementArgs,
  environmentId: string
): AgentLaunchTabPlacement {
  const owner = { environmentId }
  const { worktreeId, tabId, leafId, groupId, sessionId } = args
  const visibleTabId = resolveWebSessionVisibleTabId(useAppStore.getState(), worktreeId)
  // The mirror holds one focus intent per workspace, so it names the terminal, the slow surface;
  // a chat answers fast and takes the intent over on the reply.
  recordWebSessionFocusIntent(owner, worktreeId, tabId, leafId, visibleTabId)
  const placement = { environmentId, worktreeId, hostTabId: tabId }
  let releaseGroup = (): void => {}
  if (groupId) {
    // Held as a local launch holds it: a workspace reveal before the send reconciles tabs, which
    // drops an empty split nothing holds, and the tab would then arrive in another group.
    releaseGroup = reserveAgentLaunchTab(launchTabIds(tabId, sessionId), { worktreeId, groupId })
    recordWebSessionTerminalPlacement({ ...placement, groupId })
    // Consumed once the tab materializes: a record left for the prompt's wait would yank a tab
    // the user drags back into this group.
    void settleWebRuntimeTerminalPlacement(environmentId, worktreeId, tabId, {
      groupId,
      activate: true
    })
      .catch((error: unknown) => {
        console.warn('[agent-launch] placing the launched tab failed', error)
      })
      .finally(releaseGroup)
  }
  return {
    settle: (result) => {
      releaseGroup()
      if (result?.outcome.kind === 'terminal') {
        return
      }
      clearWebSessionFocusIntentIfMatches(owner, worktreeId, tabId, leafId)
      forgetWebSessionTerminalPlacement(placement)
      if (result?.outcome.kind === 'structured') {
        recordWebSessionFocusIntent(
          owner,
          worktreeId,
          chatHostTabId(result.outcome.sessionId),
          undefined,
          visibleTabId
        )
        // The chat's tab was published before this reply, so its snapshot is applied again.
        void refreshWebRuntimeSessionTabsSnapshot(environmentId, worktreeId, {
          acceptCurrentSnapshot: true
        }).catch((error: unknown) => {
          console.warn('[agent-launch] focusing the launched chat failed', error)
        })
      }
    }
  }
}

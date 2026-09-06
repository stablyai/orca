import type { AgentType } from '../../../../shared/agent-status-types'
import { nativeChatRequiresLocalTranscript } from '../../../../shared/native-chat-agent-support'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../../shared/tui-agent'

/** Whether this renderer may render a chat surface for a leaf AT ALL, given who
 *  actually executes it. Agents whose hook discloses no transcript path (OMP,
 *  Grok) are only reachable by scanning a sessions root on a disk this process
 *  can read, so a leaf executing on another host has no readable transcript —
 *  reading local disk for it is the silent substitution
 *  docs/reference/ssh-execution-boundary.md forbids. Agent-conditioned on
 *  purpose: Claude/Codex disclose their own path and stay renderable over SSH.
 *  An unknown agent cannot be shown to need a local transcript, so it is not
 *  refused here — the toggle gate that knows the agent is what closes that. */
export function nativeChatHostCanRenderLeafTranscript(args: {
  agent: TuiAgent | AgentType | null | undefined
  transcriptIsLocalReadable: boolean
}): boolean {
  return !nativeChatRequiresLocalTranscript(args.agent) || args.transcriptIsLocalReadable
}

function layoutNodeContainsLeaf(node: TerminalPaneLayoutNode | null, leafId: string): boolean {
  if (!node) {
    return false
  }
  if (node.type === 'leaf') {
    return node.leafId === leafId
  }
  return layoutNodeContainsLeaf(node.first, leafId) || layoutNodeContainsLeaf(node.second, leafId)
}

export function resolveNativeChatActiveLayoutLeafId(
  layout: TerminalLayoutSnapshot | null | undefined
): string | null {
  if (!layout) {
    return null
  }
  if (layout.activeLeafId) {
    // Why: close/hydration races can leave activeLeafId one snapshot behind
    // the topology; stale pane evidence must not route chat to a removed leaf.
    return !layout.root || layoutNodeContainsLeaf(layout.root, layout.activeLeafId)
      ? layout.activeLeafId
      : null
  }
  return layout.root?.type === 'leaf' ? layout.root.leafId : null
}

export function isNativeChatTabWideFallbackSafe(
  layout: TerminalLayoutSnapshot | null | undefined
): boolean {
  if (!layout?.root) {
    return true
  }
  if (layout.root.type === 'split') {
    return false
  }
  // Why: a stale active id means the single-leaf collapse is not yet settled;
  // tab-wide launch/title evidence could still describe the removed sibling.
  return !layout.activeLeafId || layout.activeLeafId === layout.root.leafId
}

/** Whether tab-wide launch evidence (agent hint, launch draft) describes this
 *  leaf: it must still be the tab's sole pane and the one the evidence bound to. */
export function nativeChatLeafOwnsTabWideEvidence(args: {
  ownerLeafId: string | null
  leafId: string | null
  leafIds: readonly string[]
}): boolean {
  const { ownerLeafId, leafId, leafIds } = args
  if (!ownerLeafId || !leafId) {
    return false
  }
  // Why: the evidence belongs to the tab's original pane. Once a split exists,
  // it says nothing about any particular sibling.
  return leafIds.length === 1 && leafIds[0] === leafId && ownerLeafId === leafId
}

export function nativeChatLaunchAgentForLeaf(args: {
  launchAgent?: TuiAgent | null
  launchAgentLeafId: string | null
  leafId: string | null
  leafIds: readonly string[]
}): TuiAgent | null {
  const { launchAgent, launchAgentLeafId, leafId, leafIds } = args
  if (!launchAgent) {
    return null
  }
  return nativeChatLeafOwnsTabWideEvidence({
    ownerLeafId: launchAgentLeafId,
    leafId,
    leafIds
  })
    ? launchAgent
    : null
}

export type NativeChatLeafRoute = {
  chatLeafId: string | null
  exitChat: boolean
}

export function resolveNativeChatLeafRoute(args: {
  isChatViewMode: boolean
  chatLeafId: string | null
  activeLeafId: string | null
  chatLeafStillMounted: boolean
  activeLeafIsEligible: boolean
  chatLeafHasConfirmedAgentExit?: boolean
  structuredSessionId?: string | null
  /** The owning leaf's host verdict from `nativeChatHostCanRenderLeafTranscript`.
   *  Absent means the caller has no verdict to offer; only an explicit `false`
   *  retires the leaf. */
  hostCanRenderTranscript?: boolean
}): NativeChatLeafRoute {
  const confirmedAgentExit = args.chatLeafHasConfirmedAgentExit && !args.structuredSessionId
  if (args.hostCanRenderTranscript === false) {
    // Why (XLR-034): the owning leaf is retained across a Terminal↔Chat toggle
    // by design — the pane-anchored RPC owner must survive it — which also
    // means the toggle BACK into Chat is never re-gated by active-leaf
    // eligibility. So once the authoritative execution host says this renderer
    // cannot read the pane's transcript (a worktree that resolved to `ssh:`
    // beneath a repository row still marked local), the retained leaf is
    // exactly what lets Chat reopen against local disk for a remotely owned
    // session. Drop the ownership; `exitChat` only when Chat is what is showing.
    return { chatLeafId: null, exitChat: args.isChatViewMode }
  }
  if (!args.isChatViewMode) {
    // Keep the owning leaf stable while its Chat surface is hidden. The
    // pane-anchored RPC owner must survive Terminal↔Chat view toggles.
    return { chatLeafId: args.chatLeafId, exitChat: false }
  }
  if (args.structuredSessionId) {
    return {
      chatLeafId: args.chatLeafId ?? args.activeLeafId,
      exitChat: false
    }
  }
  if (args.chatLeafId && args.chatLeafStillMounted && !confirmedAgentExit) {
    // Why: agent/title evidence can disappear while local, SSH, or runtime
    // transports reconnect. A mounted owning pane is not a terminal lifecycle
    // event, so keep its chat surface until the pane itself is removed.
    return { chatLeafId: args.chatLeafId, exitChat: false }
  }
  // Manager hydration can briefly have no active pane; preserve the requested
  // mode until a concrete leaf exists instead of toggling it off during mount.
  if (!args.activeLeafId && !confirmedAgentExit) {
    return { chatLeafId: args.chatLeafId, exitChat: false }
  }
  if (args.activeLeafIsEligible && (!confirmedAgentExit || args.activeLeafId !== args.chatLeafId)) {
    return { chatLeafId: args.activeLeafId, exitChat: false }
  }
  // Why: removing the owning leaf or confirming its agent exited must not leave
  // the composer targeting a plain shell. Return the tab to terminal mode.
  return { chatLeafId: null, exitChat: true }
}

import type { Tab } from '../../../../shared/tab-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { AppState } from '@/store/types'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  isNativeChatSupportedAgent,
  nativeChatRequiresLocalTranscript,
  resolveNativeChatTranscriptAgent
} from '@/lib/native-chat-supported-agent'

export { isNativeChatSupportedAgent }

/** Inputs that decide whether a tab may toggle into the native chat view.
 *  Kept as a plain shape (not the live store) so the decision stays pure and
 *  unit-testable; call sites resolve `launchAgent`/`detectedAgent` from the
 *  terminal tab + agent-status before calling. */
export type NativeChatAvailabilityInput = {
  /** Feature flag: hidden unless enabled from Settings > Experimental. */
  experimentalNativeChatEnabled?: boolean
  contentType: Tab['contentType']
  /** The coding-agent Orca launched in this terminal, if any (from TerminalTab). */
  launchAgent?: TuiAgent | null
  /** The agent identity from a live agent-status entry for any pane of this tab,
   *  when one exists — i.e. an agent detected at runtime even though
   *  `launchAgent` was not set (manually-started agents, resumed sessions). */
  detectedAgent?: AgentType | null
  /** The agent identity from another trusted tab signal (for example the
   *  terminal title resolver) when it identifies the foreground as an agent
   *  before hooks arrive. */
  resolvedAgent?: TuiAgent | null
  /** Whether this renderer's native-chat reader can access the agent transcript. */
  nativeChatTranscriptIsLocalReadable?: boolean
  /** WSL distro the terminal's project runtime resolves to, when any. OpenCode's
   *  DB reader resolves the desktop host's data dir and cannot reach a WSL
   *  guest's opencode.db. */
  wslDistro?: string | null
  /** Already-chat tabs must always be allowed to toggle back to terminal, even
   *  if live hook state was lost during a dev/app restart. */
  isChatViewMode?: boolean
}

/** WSL distro the worktree's project runtime resolves to, or null on the
 *  Windows host — the shared source for every native-chat toggle surface's
 *  WSL rule (OpenCode's DB reader cannot reach a guest's opencode.db). */
export function getNativeChatToggleWslDistro(state: AppState, worktreeId: string): string | null {
  const resolution = getLocalProjectExecutionRuntimeContext(state, worktreeId)
  return resolution?.status === 'resolved' && resolution.runtime.kind === 'wsl'
    ? resolution.runtime.distro
    : null
}

/** Native chat is a rendering of a coding-agent conversation, so the toggle is
 *  only meaningful on terminals that actually run an agent we can parse. Plain
 *  shells, non-terminal surfaces (editor, browser, …), and unsupported agents
 *  (Gemini, …) never qualify. Live identity is authoritative when present;
 *  launch metadata is next, and title resolution only fills the pre-hook gap for
 *  manually-started Claude/Codex/Grok sessions. */
export function canToggleNativeChat(input: NativeChatAvailabilityInput): boolean {
  if (input.experimentalNativeChatEnabled !== true) {
    return false
  }
  if (input.contentType !== 'terminal') {
    return false
  }
  if (input.isChatViewMode === true) {
    return true
  }
  const agent = input.detectedAgent ?? input.launchAgent ?? input.resolvedAgent
  if (
    nativeChatRequiresLocalTranscript(agent) &&
    input.nativeChatTranscriptIsLocalReadable !== true
  ) {
    return false
  }
  // Why: OpenCode's opencode.db resolves on the desktop host only — a WSL
  // guest session's DB is unreachable, so the toggle must never offer a chat
  // that can only render an endless loading state (#9307 expectation 5).
  if (input.wslDistro?.trim() && resolveNativeChatTranscriptAgent(agent) === 'opencode') {
    return false
  }
  return isNativeChatSupportedAgent(agent)
}

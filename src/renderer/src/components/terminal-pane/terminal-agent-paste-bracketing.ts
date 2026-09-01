import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  isBuiltInTuiAgent,
  isTuiAgent,
  TUI_AGENT_CONFIG
} from '../../../../shared/tui-agent-config'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { resolvePaneOwnerBaseAgent } from '../../lib/agent-base-identity'
import type { PaneForegroundAgentEntry } from '../../store/slices/pane-foreground-agent'
import type { TerminalPasteTextOptions } from './terminal-paste-model'

/**
 * Why: xterm brackets a paste only after seeing DECSET 2004, which can be lost by
 * remote replay or ConPTY. Unprotected CR submits an agent's parked draft.
 *
 * Why keyed on the pane's agent and not on the mode bit itself: "we never observed
 * DECSET 2004" is not usable evidence. Measured in real ptys — zsh 5.9, fish 4.8.1 and
 * bash >= 5.1 emit `?2004h` at the prompt and `?2004l` just before exec, but macOS
 * /bin/bash 3.2, /bin/sh, bash 4.4, and any shell with bracketed paste turned off in
 * .inputrc/zle emit *nothing at all*. A deliberate opt-out is byte-identical to a bare
 * `cat`. So silence cannot be read as "nobody has an opinion".
 *
 * Agent identity disambiguates silence because a TUI agent enables bracketed paste.
 * A verified Windows input-record agent cannot receive paste frames; for that explicit
 * capability, use the same modified-Enter newline contract as Shift+Enter.
 *
 * Why this diverges from terminal-ctrl-enter / terminal-windows-shift-enter, which veto
 * on shellForeground/routingRevoked and require routingTrusted: those resolvers decide
 * where to ROUTE input bytes, so a forged identity misdelivers keystrokes. This one only
 * decides how to encode a user-requested paste, whose ESC bytes are sanitized downstream.
 */
export function resolveProtectedMultilinePasteOptionsForPane({
  isWindowsClient,
  hostPlatform,
  agentStatusByPaneKey,
  paneForegroundAgentByPaneKey,
  tabId,
  leafId
}: {
  isWindowsClient: boolean
  hostPlatform: NodeJS.Platform
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry>
  tabId: string
  leafId: string
}): TerminalPasteTextOptions | undefined {
  let paneKey: string
  try {
    paneKey = makePaneKey(tabId, leafId)
  } catch {
    // Why: unreachable today (pane.leafId is a minted UUID), but a legacy/malformed
    // layout must degrade to the pre-fix path, not throw out of the paste handler --
    // the throw would escape before pasteTerminalClipboard's catch is attached and
    // the paste would be a silent no-op with no error surface.
    return isWindowsClient ? { forceBracketedPasteForMultiline: true } : undefined
  }
  return resolveProtectedMultilinePasteOptionsForAgentEvidence({
    isWindowsClient,
    hostPlatform,
    foregroundAgent: paneForegroundAgentByPaneKey[paneKey]?.agent,
    entry: agentStatusByPaneKey[paneKey]
  })
}

export function resolveProtectedMultilinePasteOptionsForAgentEvidence({
  isWindowsClient,
  hostPlatform,
  foregroundAgent,
  entry
}: {
  isWindowsClient: boolean
  hostPlatform: NodeJS.Platform
  foregroundAgent: unknown
  entry: AgentStatusEntry | undefined
}): TerminalPasteTextOptions | undefined {
  // Why: a row rehydrated from disk across a restart describes the previous process,
  // not the shell now attached to this pane.
  const agent = isTuiAgent(foregroundAgent)
    ? foregroundAgent
    : entry?.restoredUnconfirmed !== true && isTuiAgent(entry?.agentType)
      ? entry.agentType
      : null
  // Why NOT vetoed on shellForeground: that flag is republished only at OSC 133
  // boundaries, so a shell without 133 integration leaves it latched true while an
  // agent owns the foreground. Vetoing on it silently reinstates the submit bug —
  // measured live. An idle agent also sits at `done` past the 30-minute freshness
  // TTL, so neither state nor TTL can gate this either. A false negative sends the
  // user's parked draft; a false positive only changes encoding within this paste.
  // Why base-resolved and guarded: TUI_AGENT_CONFIG is keyed by built-in ids only,
  // and `agent` can be a custom id (agent-status rows and pty launch metadata keep
  // it unresolved). Indexing raw threw on every multiline paste into a custom pane;
  // a catalog-orphaned id keeps `agent` truthy and falls to plain bracketing below.
  const baseAgent = resolvePaneOwnerBaseAgent(agent ?? undefined)
  const windowsInputRecordPasteNewline = isBuiltInTuiAgent(baseAgent)
    ? TUI_AGENT_CONFIG[baseAgent].windowsInputRecordPasteNewline
    : undefined
  if (hostPlatform === 'win32' && windowsInputRecordPasteNewline) {
    return {
      windowsInputRecordNewline: windowsInputRecordPasteNewline
    }
  }
  return isWindowsClient || agent ? { forceBracketedPasteForMultiline: true } : undefined
}

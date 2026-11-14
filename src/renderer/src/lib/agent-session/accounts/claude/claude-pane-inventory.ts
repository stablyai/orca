/** Local terminal panes that run Claude, found from status rows, saved records, process reads or launches. */
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess
} from '@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection'
import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../../../../../shared/agent-status/process/agent-process-recognition'
import { normalizeAgentProviderSession } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  isTerminalLeafId,
  makePaneKey
} from '../../../../../../shared/workspace-layout/stable-pane-id'
import { isClientOnlyUnverifiableInspection } from '../../../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import type { TerminalProcessInspection as RuntimeTerminalProcessInspection } from '../../../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import { getCodexSelectionLaneKey } from '../../../../../../shared/codex-selection-lane'
import type { CodexAccountSelectionTarget } from '../../../../../../shared/codex-selection-lane'
import { resolvePaneAgentSessionId } from '@/lib/agent-session/identity/pane-agent-session-id'
import {
  getCodexAccountSwitchLaneMatcher,
  isForeignMachineCodexPtyId,
  isLocalCodexSelectionLaneKey,
  resolveCodexPaneSelectionLane
} from '../codex-pane-selection-lane'
import type { AppState } from '@/store/types'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'

export type ClaudeSessionMoveCandidate = {
  ptyId: string
  worktreeId: string
  tabId: string
  leafId: string
}

/** Match npm Claude by its fresh command line: generic node/python may now run user programs.
 *  Agent Teams: a packaged `orca claude-teams` leads the foreground as `Orca`, a name any `orca` command shares. */
function isClaudeProcess(processName: string | null, agentTeams: boolean): boolean {
  const agent = recognizeAgentProcess(processName)?.agent
  return agent === 'claude' || (agentTeams && agent === 'claude-agent-teams')
}

/** Confirm foreground identity: cached names flap to shells and native macOS binaries report version-folder names. */
async function isClaudeInForeground(
  ptyId: string,
  inspection: RuntimeTerminalProcessInspection,
  agentTeams: boolean
): Promise<boolean | 'unchecked'> {
  if (isClientOnlyUnverifiableInspection(inspection)) {
    return false
  }
  if (isClaudeProcess(inspection.foregroundProcess, agentTeams)) {
    return true
  }
  const fresh = await confirmRuntimeTerminalForegroundProcess(ptyId)
  // Why: a bare node/python may be an npm Claude, but only the failed fresh read could have said so.
  if (fresh === null && isAgentForegroundWrapperProcess(inspection.foregroundProcess ?? '')) {
    return 'unchecked'
  }
  return isClaudeProcess(fresh, agentTeams)
}

export type LocalClaudePane = ClaudeSessionMoveCandidate & {
  tab: TerminalTab
  laneKey: string
  inLane: boolean
  transcriptPath: string | undefined
  sessionId: string | undefined
  /** False when neither a live row nor a saved record names the session, so no restart can resume it. */
  resumable: boolean
  /** Agent Teams' wrapper evidence for this pane: its own process read, or a one-pane tab's launch. */
  agentTeams: boolean
}

function isClaudeAgent(agent: string | null | undefined): boolean {
  return agent === 'claude' || agent === 'claude-agent-teams'
}

/** A tab-wide launch names only a one-pane tab's agent; a split leaf may run anything. */
function paneLaunchAgent(state: AppState, tab: TerminalTab): string | undefined {
  const leaves = state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}
  return Object.keys(leaves).length === 1 ? tab.launchAgent : undefined
}

/** Why: hooks off, or not reported yet, leave no status row; the process read or launch still say Claude. */
function hasRowlessClaudeEvidence(state: AppState, tab: TerminalTab, paneKey: string): boolean {
  const foreground = state.paneForegroundAgentByPaneKey[paneKey]
  if (foreground?.shellForeground) {
    return false
  }
  return isClaudeAgent(foreground?.agent) || isClaudeAgent(paneLaunchAgent(state, tab))
}

export function* localClaudePanes(
  state: AppState,
  owner: RuntimeClientTarget,
  target: CodexAccountSelectionTarget
): Generator<LocalClaudePane> {
  const isLaneInScope = getCodexAccountSwitchLaneMatcher({ owner, target })
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      const boundPtyIds = state.ptyIdsByTabId[tab.id] ?? []
      const leaves = state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}
      for (const [leafId, ptyId] of Object.entries(leaves)) {
        if (
          !ptyId ||
          !isTerminalLeafId(leafId) ||
          !boundPtyIds.includes(ptyId) ||
          isForeignMachineCodexPtyId(ptyId)
        ) {
          continue
        }
        const paneKey = makePaneKey(tab.id, leafId)
        const entry = state.agentStatusByPaneKey[paneKey]
        if (entry && (entry.agentType !== 'claude' || entry.structuredHostOwned)) {
          continue
        }
        // Why the record: a dismissed row leaves the saved session the restart itself resumes.
        const record = entry ? undefined : state.sleepingAgentSessionsByPaneKey[paneKey]
        const saved = record?.agent === 'claude' ? record.providerSession : undefined
        if (!entry && !saved && !hasRowlessClaudeEvidence(state, tab, paneKey)) {
          continue
        }
        const { laneKey } = resolveCodexPaneSelectionLane({ state, tab, ptyId })
        const providerSession = normalizeAgentProviderSession(entry?.providerSession ?? saved)
        const foregroundAgent = state.paneForegroundAgentByPaneKey[paneKey]?.agent
        yield {
          ptyId,
          worktreeId,
          tabId: tab.id,
          leafId,
          tab,
          laneKey,
          inLane: isLaneInScope(laneKey),
          transcriptPath: providerSession?.transcriptPath,
          sessionId: providerSession?.id,
          resumable: Boolean(entry || saved),
          agentTeams:
            foregroundAgent === 'claude-agent-teams' ||
            paneLaunchAgent(state, tab) === 'claude-agent-teams'
        }
      }
    }
  }
}

export function isWslLane(laneKey: string): boolean {
  return isLocalCodexSelectionLaneKey(laneKey) && laneKey !== getCodexSelectionLaneKey(null)
}

export async function isClaudeRunning(
  state: AppState,
  pane: LocalClaudePane
): Promise<boolean | 'unchecked'> {
  // Why: a Windows host cannot see processes inside WSL, so the guest's hooks and shell marks decide.
  if (isWslLane(pane.laneKey)) {
    const paneKey = makePaneKey(pane.tabId, pane.leafId)
    return pane.resumable
      ? resolvePaneAgentSessionId(state, paneKey) !== null
      : hasRowlessClaudeEvidence(state, pane.tab, paneKey)
  }
  return inspectRuntimeTerminalProcess(pane.ptyId).then(
    (inspection) => isClaudeInForeground(pane.ptyId, inspection, pane.agentTeams),
    () => false
  )
}

/** Local terminal panes that run Claude, found from status rows, saved records, process reads or launches. */
import {
  claudeAccountBindingForWorkspace,
  type ClaudeWorkspaceBindingLookup
} from '../../../../../../shared/agent-accounts/claude/claude-workspace-account-binding'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
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
import { getCodexSelectionLaneKey } from '../../../../../../shared/agent-accounts/codex/codex-selection-lane'
import type { CodexAccountSelectionTarget } from '../../../../../../shared/agent-accounts/codex/codex-selection-lane'
import {
  getCodexAccountSwitchLaneMatcher,
  isForeignMachineCodexPtyId,
  isLocalCodexSelectionLaneKey,
  resolveCodexPaneSelectionLane
} from '../codex-pane-selection-lane'
import type { AppState } from '@/store/types'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
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
    return inspection.reason === 'terminal_gone' ? false : 'unchecked'
  }
  if (isClaudeProcess(inspection.foregroundProcess, agentTeams)) {
    return true
  }
  const fresh = await confirmRuntimeTerminalForegroundProcess(ptyId)
  // Why: a bare node/python may be an npm Claude, but only the failed fresh read could have said so.
  if (fresh === null && isAgentForegroundWrapperProcess(inspection.foregroundProcess ?? '')) {
    return 'unchecked'
  }
  if (
    recognizeAgentProcess(fresh ?? inspection.foregroundProcess)?.agent === 'claude-agent-teams' &&
    !agentTeams
  ) {
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
  /** A live process read, since any Orca command shares Agent Teams' executable name. */
  agentTeams: boolean
}

function isClaudeAgent(agent: string | null | undefined): boolean {
  return agent === 'claude' || agent === 'claude-agent-teams'
}

function hasRowlessClaudeEvidence(
  state: AppState,
  paneKey: string,
  launchAgent: string | undefined
): boolean {
  const foreground = state.paneForegroundAgentByPaneKey[paneKey]
  return (
    !foreground?.shellForeground && (isClaudeAgent(foreground?.agent) || isClaudeAgent(launchAgent))
  )
}

export function* localClaudePanes(
  state: AppState,
  owner: RuntimeClientTarget,
  target: CodexAccountSelectionTarget
): Generator<LocalClaudePane> {
  const isLaneInScope = getCodexAccountSwitchLaneMatcher({ owner, target })
  const bindings: ClaudeWorkspaceBindingLookup = {
    getRepo: (id) => state.repos.find((repo) => repo.id === id),
    getFolderWorkspace: (id) => selectFolderWorkspaces(state).find((folder) => folder.id === id),
    getProjectGroups: () => state.projectGroups
  }
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    // A project bound to a Claude account keeps its terminals on it through any switch.
    if (claudeAccountBindingForWorkspace(worktreeId, bindings)) {
      continue
    }
    for (const tab of tabs) {
      const boundPtyIds = new Set(state.ptyIdsByTabId[tab.id] ?? [])
      const leaves = Object.entries(state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {})
      const launchAgent = leaves.length === 1 ? tab.launchAgent : undefined
      for (const [leafId, ptyId] of leaves) {
        if (
          !ptyId ||
          !isTerminalLeafId(leafId) ||
          !boundPtyIds.has(ptyId) ||
          isForeignMachineCodexPtyId(ptyId)
        ) {
          continue
        }
        const paneKey = makePaneKey(tab.id, leafId)
        const entry = state.agentStatusByPaneKey.get(paneKey)
        if (entry && (entry.agentType !== 'claude' || entry.structuredHostOwned)) {
          continue
        }
        // Why the record: a dismissed row leaves the saved session the restart itself resumes.
        const record = state.sleepingAgentSessionsByPaneKey[paneKey]
        const saved = record?.agent === 'claude' ? record.providerSession : undefined
        const hasClaudeEvidence = hasRowlessClaudeEvidence(state, paneKey, launchAgent)
        if (!entry && !saved && !hasClaudeEvidence) {
          continue
        }
        const { laneKey } = resolveCodexPaneSelectionLane({ state, tab, ptyId })
        const providerSession =
          normalizeAgentProviderSession(entry?.providerSession) ??
          normalizeAgentProviderSession(saved)
        const foreground = state.paneForegroundAgentByPaneKey[paneKey]
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
          resumable: Boolean(providerSession),
          agentTeams:
            foreground?.agent === 'claude-agent-teams' &&
            foreground.agentEvidence === 'process-read' &&
            !foreground.shellForeground
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
    if (state.paneForegroundAgentByPaneKey[paneKey]?.shellForeground) {
      return false
    }
    const live = state.agentStatusByPaneKey.get(paneKey)
    if (live?.agentType === 'claude' && live.restoredUnconfirmed !== true) {
      return true
    }
    const foreground = state.paneForegroundAgentByPaneKey[paneKey]
    return foreground?.agentEvidence === 'process-read' && isClaudeAgent(foreground.agent)
      ? true
      : 'unchecked'
  }
  return inspectRuntimeTerminalProcess(pane.ptyId).then(
    (inspection) => isClaudeInForeground(pane.ptyId, inspection, pane.agentTeams),
    () => 'unchecked'
  )
}

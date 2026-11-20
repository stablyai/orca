/** Local agent terminal sessions a manual restart can resume, and why the others cannot. */
import { useAppStore } from '@/store/index'
import { inspectRuntimeTerminalProcess } from '@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import {
  isResumableTuiAgent,
  normalizeAgentProviderSession
} from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  claudeLaunchAccountId,
  isClaudePaneOnAccount,
  resolveClaudePaneFolder
} from '../../../../../shared/agent-accounts/claude/claude-pane-account-folder'
import { getRendererAppPlatform } from '../../../app-shell/platform/renderer-app-platform'
import {
  isAgentInForeground,
  isAgentTeamsLead,
  isWslLane,
  localTerminalLeaves
} from '../accounts/claude/claude-pane-inventory'
import type { LocalTerminalLeaf } from '../accounts/claude/claude-pane-inventory'
import { resolveCodexPaneSelectionLane } from '../accounts/codex-pane-selection-lane'
import { buildManualRestartStartup } from '../accounts/agent-account-restart-startup'
import { isSessionHeldByAnotherPane } from '../identity/claude-session-pane-holders'
import { getAgentPaneQuietEvidence, isAgentPaneQuiet } from '../hibernation/agent-pane-quiet'
import { collectAgentPaneInputEvidence } from '../hibernation/agent-hibernation-coordinator'
import { collectHostPtyEvidence } from '../hibernation/agent-hibernation-host-evidence'
import { toRuntimePtyId } from '../hibernation/agent-hibernation-pane-eligibility'
import type { AppState } from '@/store/types'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type {
  AgentProviderSessionMetadata,
  ResumableTuiAgent
} from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { ClaudeHostFolders } from '../../../../../shared/agent-accounts/claude/claude-pane-account-folder'

export type AgentRestartCantReason =
  | 'no-session'
  | 'shared-session'
  | 'wsl-terminal'
  | 'agent-teams-lead'
  | 'own-folder'
  | 'couldnt-check'
  | 'no-cwd'
  | 'other-account'

/** A restartable session always names a resumable agent; agents without resume list as `no-session`. */
type RestartVerdict =
  | { restartable: true; agent: ResumableTuiAgent; reason?: undefined }
  | { restartable: false; agent: TuiAgent; reason: AgentRestartCantReason }

export type AgentRestartCandidate = {
  ptyId: string
  worktreeId: string
  tabId: string
  leafId: string
  /** Checked by default only when restartable and quiet, and shown as Working otherwise; a restored, unconfirmed row is never quiet. */
  quiet: boolean
} & RestartVerdict

// Why: these resume by work folder (agent-resume-argv.ts), so without the recorded one they reopen another session.
const WORK_FOLDER_SCOPED_AGENTS: ReadonlySet<TuiAgent> = new Set(['kimi', 'dsh'])

type AgentPane = LocalTerminalLeaf & {
  agent: TuiAgent
  providerSession: AgentProviderSessionMetadata | null
  agentTeams: boolean
  wsl: boolean
}

type ClaudeAccountView = {
  host: ClaudeHostFolders
  launchAccountId: string | null
}

/** Agent evidence in order: status row, saved record, process read, then a one-pane tab's launch. */
function* localAgentPanes(state: AppState): Generator<AgentPane> {
  for (const leaf of localTerminalLeaves(state)) {
    const entry = state.agentStatusByPaneKey.get(leaf.paneKey)
    // Why: a native chat row is a host-held structured session, not a terminal CLI.
    if (entry?.structuredHostOwned) {
      continue
    }
    const record = state.sleepingAgentSessionsByPaneKey[leaf.paneKey]
    const foreground = state.paneForegroundAgentByPaneKey[leaf.paneKey]
    const rowless = foreground?.shellForeground ? [] : [foreground?.agent, leaf.launchAgent]
    const found = [entry?.agentType, record?.agent, ...rowless].find(isTuiAgent)
    if (!found) {
      continue
    }
    // Why: an Agent Teams lead runs Claude's own session; the lead check keeps it from restarting.
    const agent = found === 'claude-agent-teams' ? 'claude' : found
    yield {
      ...leaf,
      agent,
      providerSession:
        normalizeAgentProviderSession(
          entry?.agentType === agent ? entry.providerSession : undefined
        ) ??
        normalizeAgentProviderSession(record?.agent === agent ? record.providerSession : undefined),
      agentTeams: agent === 'claude' && isAgentTeamsLead(state, leaf.paneKey),
      wsl: isWslLane(
        resolveCodexPaneSelectionLane({ state, tab: leaf.tab, ptyId: leaf.ptyId }).laneKey
      )
    }
  }
}

function readAgentRunning(state: AppState, pane: AgentPane): Promise<boolean | 'unchecked'> {
  // Why: a Windows host cannot see processes inside WSL, so only the guest's shell mark says the agent ended.
  if (pane.wsl) {
    return Promise.resolve(!state.paneForegroundAgentByPaneKey[pane.paneKey]?.shellForeground)
  }
  return inspectRuntimeTerminalProcess(pane.ptyId).then(
    (inspection) => isAgentInForeground(pane.ptyId, inspection, pane.agent, pane.agentTeams),
    () => 'unchecked' as const
  )
}

/** Undefined when the host's folders cannot be read: an own folder would then pass for System default. */
async function readClaudeAccountView(state: AppState): Promise<ClaudeAccountView | undefined> {
  let host: ClaudeHostFolders
  try {
    host = await window.api.claudeAccounts.list()
  } catch {
    return undefined
  }
  const selected =
    state.settings?.activeClaudeManagedAccountIdsByRuntime?.host ??
    state.settings?.activeClaudeManagedAccountId ??
    null
  return { host, launchAccountId: claudeLaunchAccountId(host, selected) }
}

function claudeAccountReason(
  state: AppState,
  session: AgentProviderSessionMetadata,
  view: ClaudeAccountView
): AgentRestartCantReason | null {
  const folder = resolveClaudePaneFolder(
    session.transcriptPath,
    state.settings?.claudeManagedAccounts ?? [],
    view.host,
    getRendererAppPlatform()
  )
  // Why fail closed: the restart launches on the selected account, which may not be this pane's.
  if (!folder) {
    return 'couldnt-check'
  }
  if (folder.kind === 'own-folder') {
    return 'own-folder'
  }
  return isClaudePaneOnAccount(folder, view.launchAccountId, view.host) ? null : 'other-account'
}

function judgeRestart(
  state: AppState,
  pane: AgentPane,
  running: true | 'unchecked',
  claudeView: ClaudeAccountView | undefined
): RestartVerdict {
  const cant = (reason: AgentRestartCantReason): RestartVerdict => ({
    restartable: false,
    agent: pane.agent,
    reason
  })
  const { agent, providerSession: session } = pane
  if (pane.wsl) {
    return cant('wsl-terminal')
  }
  if (running === 'unchecked') {
    return cant('couldnt-check')
  }
  if (pane.agentTeams) {
    return cant('agent-teams-lead')
  }
  if (!isResumableTuiAgent(agent) || !session) {
    return cant('no-session')
  }
  if (WORK_FOLDER_SCOPED_AGENTS.has(agent) && !session.cwd) {
    return cant('no-cwd')
  }
  if (agent === 'claude') {
    const accountReason = claudeView
      ? claudeAccountReason(state, session, claudeView)
      : 'couldnt-check'
    if (accountReason) {
      return cant(accountReason)
    }
  }
  // Why dismissed too: the notice means this pane runs on an account other than the selected one.
  if (agent === 'codex' && state.codexRestartNoticeByPtyId[pane.ptyId]) {
    return cant('other-account')
  }
  if (isSessionHeldByAnotherPane(state, pane.paneKey, session.id, agent)) {
    return cant('shared-session')
  }
  const startup = buildManualRestartStartup(agent, {
    tabId: pane.tabId,
    leafId: pane.leafId,
    worktreeId: pane.worktreeId,
    shellOverride: pane.tab.shellOverride
  })
  return startup ? { restartable: true, agent } : cant('no-session')
}

/** Sessions whose agent has exited, and sleeping or remote panes, are left out. */
export async function localAgentRestartCandidates(
  state: AppState
): Promise<AgentRestartCandidate[]> {
  const panes = [...localAgentPanes(state)]
  const [running, hostEvidence, claudeView] = await Promise.all([
    Promise.all(panes.map((pane) => readAgentRunning(state, pane))),
    collectHostPtyEvidence(state),
    panes.some((pane) => pane.agent === 'claude') ? readClaudeAccountView(state) : undefined
  ])
  // Why fresh: the scan can wait seconds on a slow host, and a turn that starts meanwhile must not start ticked.
  const fresh = useAppStore.getState()
  const input = collectAgentPaneInputEvidence(fresh)
  const inUsePtyIds = new Set(input.inUsePtyIds)
  return panes.flatMap((pane, index): AgentRestartCandidate[] => {
    const paneRunning = running[index]
    if (paneRunning === false) {
      return []
    }
    const entry = fresh.agentStatusByPaneKey.get(pane.paneKey)
    const runtimePtyId = toRuntimePtyId(pane.ptyId)
    const evidence = getAgentPaneQuietEvidence(
      input.lastTerminalInputAtByPaneKey[pane.paneKey],
      hostEvidence.attentionByWorktreeId[pane.worktreeId]?.[runtimePtyId],
      inUsePtyIds.has(runtimePtyId)
    )
    return [
      {
        ptyId: pane.ptyId,
        worktreeId: pane.worktreeId,
        tabId: pane.tabId,
        leafId: pane.leafId,
        quiet: !!entry && !entry.restoredUnconfirmed && isAgentPaneQuiet(entry, evidence),
        ...judgeRestart(state, pane, paneRunning, claudeView)
      }
    ]
  })
}

/**
 * Finds the running agent terminal sessions an account switch can move, from the account each
 * session's transcript says it runs on. Agent-neutral: the AccountSwitchAgent says how a
 * transcript maps to an account and how to confirm its process holds the pane.
 */
import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess
} from '@/runtime/runtime-terminal-inspection'
import { normalizeAgentProviderSession } from '../../../shared/agent-session-resume'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import { isClientOnlyUnverifiableInspection } from '../../../shared/terminal-process-inspection'
import type { CodexAccountSelectionTarget } from '../../../shared/codex-selection-lane'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { resolveAgentAccountRestartResumeStartup } from './agent-account-restart-startup'
import type { AccountSwitchSession } from './agent-account-switch-sessions'
import type { AccountSwitchAgent } from './agent-account-switch-agent'
import { getRendererAppPlatform } from './renderer-app-platform'
import {
  getAccountSwitchLaneMatcher,
  resolvePaneAccountSelectionLaneKey
} from './pane-account-selection-lane'

export type AgentSwitchScope = {
  owner: RuntimeClientTarget
  target: CodexAccountSelectionTarget
  /** Set when the switch cleared every WSL distro slot at once. */
  clearsEveryWslDistro?: boolean
}

export function normalizeAgentHomeFolder(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return getRendererAppPlatform() === 'win32' ? slashed.toLowerCase() : slashed
}

/** The home folder a transcript was written under: the part before its last `/<dirName>/`. */
export function transcriptHomeFolder(
  transcriptPath: string | undefined,
  dirName: string
): string | undefined {
  const transcript = transcriptPath ? normalizeAgentHomeFolder(transcriptPath) : ''
  const index = transcript.lastIndexOf(`/${dirName}/`)
  return index > 0 ? transcript.slice(0, index) : undefined
}

/** The account whose home folders include `home`, by normalized path. */
export function findAccountByHomeFolder<T>(
  home: string,
  accounts: readonly T[],
  folders: (account: T) => readonly (string | null | undefined)[]
): T | undefined {
  return accounts.find((account) =>
    folders(account).some((folder) => folder && normalizeAgentHomeFolder(folder) === home)
  )
}

type AgentPane = {
  worktreeId: string
  tab: TerminalTab
  leafId: string
  ptyId: string
  accountId: string | null | undefined
}

/** Terminal (not structured) sessions of `reader.agent` in the switch's lane, on any machine. */
function* agentPanesInLane(
  state: AppState,
  reader: AccountSwitchAgent,
  scope: AgentSwitchScope
): Generator<AgentPane> {
  const isLaneInScope = getAccountSwitchLaneMatcher(scope)
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      const boundPtyIds = state.ptyIdsByTabId[tab.id] ?? []
      const leaves = state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}
      for (const [leafId, ptyId] of Object.entries(leaves)) {
        if (!ptyId || !isTerminalLeafId(leafId) || !boundPtyIds.includes(ptyId)) {
          continue
        }
        const entry = state.agentStatusByPaneKey[makePaneKey(tab.id, leafId)]
        if (entry?.agentType !== reader.agent || entry.structuredHostOwned) {
          continue
        }
        // Why by lane: a WSL host's terminals run on this desktop's distro selection, while SSH
        // panes keep their machine's own login and match no switch.
        if (!isLaneInScope(resolvePaneAccountSelectionLaneKey({ state, tab, ptyId }))) {
          continue
        }
        const accountId = reader.transcriptAccountId(
          normalizeAgentProviderSession(entry.providerSession)?.transcriptPath,
          { state, owner: scope.owner }
        )
        yield { worktreeId, tab, leafId, ptyId, accountId }
      }
    }
  }
}

/** Queued restarts in the switch's lane whose session already runs on `accountId`. */
export function findQueuedAccountRestartsOnAccount(
  reader: AccountSwitchAgent,
  scope: AgentSwitchScope & { accountId: string | null }
): string[] {
  const state = useAppStore.getState()
  const ptyIds: string[] = []
  for (const pane of agentPanesInLane(state, reader, scope)) {
    if (
      state.pendingPaneAccountRestarts[pane.ptyId] === reader.agent &&
      pane.accountId === scope.accountId
    ) {
      ptyIds.push(pane.ptyId)
    }
  }
  return ptyIds
}

/** Whether the agent, not a shell, holds the pane, re-checked once against a fresh read. */
async function isAgentHoldingPane(reader: AccountSwitchAgent, pane: AgentPane): Promise<boolean> {
  const inspection = await inspectRuntimeTerminalProcess(pane.ptyId)
  if (isClientOnlyUnverifiableInspection(inspection)) {
    return false
  }
  if (reader.isAgentForeground(inspection, pane.tab.launchAgent)) {
    return true
  }
  // Why: the cached name can flap to the shell for a live session (#11064), and the native macOS
  // Claude reads as its version folder until a fresh read resolves it.
  const confirmed = await confirmRuntimeTerminalForegroundProcess(pane.ptyId)
  return (
    confirmed !== null &&
    reader.isAgentForeground(
      { foregroundProcess: confirmed, hasChildProcesses: inspection.hasChildProcesses },
      pane.tab.launchAgent
    )
  )
}

/**
 * Panes in the switched lane whose session runs on `fromAccountId` (null is System default), the
 * account the switch left.
 */
export async function findMovableAgentSessions(
  reader: AccountSwitchAgent,
  scope: AgentSwitchScope & { fromAccountId: string | null }
): Promise<AccountSwitchSession[]> {
  const panes: AgentPane[] = []
  for (const pane of agentPanesInLane(useAppStore.getState(), reader, scope)) {
    // Why undefined never matches: an unknown home cannot be shown to be on the old account.
    if (pane.accountId !== scope.fromAccountId) {
      continue
    }
    if (
      !reader.freshStartup &&
      !resolveAgentAccountRestartResumeStartup(reader.agent, {
        tabId: pane.tab.id,
        leafId: pane.leafId,
        worktreeId: pane.worktreeId,
        shellOverride: pane.tab.shellOverride
      })
    ) {
      continue
    }
    panes.push(pane)
  }
  const holding = await Promise.all(
    panes.map((pane) => isAgentHoldingPane(reader, pane).catch(() => false))
  )
  return panes
    .filter((_, index) => holding[index])
    .map((pane) => ({
      ptyId: pane.ptyId,
      worktreeId: pane.worktreeId,
      tabId: pane.tab.id,
      leafId: pane.leafId
    }))
}

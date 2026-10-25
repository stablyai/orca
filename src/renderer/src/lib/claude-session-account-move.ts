/**
 * Finds Claude terminal sessions to move onto a newly selected account. Why resume suffices: each
 * launch reads the selected account's folder, so `claude --resume <id>` lands there intact.
 */
import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess,
  type RuntimeTerminalProcessInspection
} from '@/runtime/runtime-terminal-inspection'
import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../../shared/agent-process-recognition'
import { normalizeAgentProviderSession } from '../../../shared/agent-session-resume'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import { isClientOnlyUnverifiableInspection } from '../../../shared/terminal-process-inspection'
import {
  normalizeCodexAccountSelectionTarget,
  type CodexAccountSelectionTarget
} from '../../../shared/codex-selection-lane'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type {
  ClaudeManagedAccount,
  ClaudeRateLimitAccountsState
} from '../../../shared/managed-account-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { resolvePaneAgentSessionId } from '@/components/terminal-pane/pane-agent-session-id'
import { resolveAgentAccountRestartResumeStartup } from './agent-account-restart-startup'
import { getRendererAppPlatform } from './renderer-app-platform'
import {
  getCodexAccountSwitchLaneMatcher,
  isForeignMachineCodexPtyId,
  resolveCodexPaneSelectionLane
} from './codex-pane-selection-lane'

export type ClaudeSessionMoveCandidate = {
  ptyId: string
  worktreeId: string
  tabId: string
  leafId: string
}

// Why not a bare node or python: after Claude exits, the pane can run the user's own program; the
// fresh read names an npm Claude `claude` from its command line.
function isClaudeProcess(processName: string | null): boolean {
  return recognizeAgentProcess(processName)?.agent === 'claude'
}

/**
 * Whether Claude holds the pane's foreground. Why confirm: cached names flap to the shell, and
 * the native macOS install reads as its version folder (`2.1.x`).
 */
async function isClaudeInForeground(
  ptyId: string,
  inspection: RuntimeTerminalProcessInspection
): Promise<boolean | 'unchecked'> {
  if (isClientOnlyUnverifiableInspection(inspection)) {
    return false
  }
  if (isClaudeProcess(inspection.foregroundProcess)) {
    return true
  }
  const fresh = await confirmRuntimeTerminalForegroundProcess(ptyId)
  // Why: a bare node/python may be an npm Claude, but only the failed fresh read could have said so.
  if (fresh === null && isAgentForegroundWrapperProcess(inspection.foregroundProcess ?? '')) {
    return 'unchecked'
  }
  return isClaudeProcess(fresh)
}

/** Whether the pane's Claude is mid-turn; a restart during a permission prompt or question drops it. */
export function isClaudePaneMidTurn(state: AppState, paneKey: string): boolean {
  const entry = state.agentStatusByPaneKey[paneKey]
  return entry?.agentType === 'claude' && entry.state !== 'done'
}

function normalizeFolder(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return getRendererAppPlatform() === 'win32' ? slashed.toLowerCase() : slashed
}

/**
 * The Claude account a session runs on, read from where Claude writes its transcript
 * (`<CLAUDE_CONFIG_DIR>/projects/...`): a managed account's folder, else System default
 * (null). Undefined when the hook reported no transcript, so the caller cannot know.
 */
export function resolveClaudeSessionAccountId(
  transcriptPath: string | undefined,
  accounts: readonly ClaudeManagedAccount[]
): string | null | undefined {
  const transcript = transcriptPath ? normalizeFolder(transcriptPath) : ''
  const projectsIndex = transcript.lastIndexOf('/projects/')
  if (projectsIndex <= 0) {
    return undefined
  }
  const configDir = transcript.slice(0, projectsIndex)
  const account = accounts.find((candidate) =>
    [candidate.managedAuthPath, candidate.wslLinuxAuthPath].some(
      (folder) => folder && normalizeFolder(folder) === configDir
    )
  )
  return account ? account.id : null
}

/**
 * The account a launch under `accountId` runs on, as a session's transcript reports it: System
 * default (null) for an account with no login of its own that System default covers.
 */
export function claudeLaunchAccountId(
  state: Pick<ClaudeRateLimitAccountsState, 'accounts'>,
  accountId: string | null
): string | null {
  const account = state.accounts.find((candidate) => candidate.id === accountId)
  return account?.runsOnSystemDefault ? null : accountId
}

type LocalClaudePane = {
  worktreeId: string
  tab: TerminalTab
  leafId: string
  ptyId: string
  /** See resolveClaudeSessionAccountId. */
  accountId: string | null | undefined
}

/** Local terminal panes with a terminal (not structured) Claude session in the switch's lane. */
function* localClaudePanesInLane(
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
        const entry = state.agentStatusByPaneKey[makePaneKey(tab.id, leafId)]
        if (entry?.agentType !== 'claude' || entry.structuredHostOwned) {
          continue
        }
        if (!isLaneInScope(resolveCodexPaneSelectionLane({ state, tab, ptyId }).laneKey)) {
          continue
        }
        const accountId = resolveClaudeSessionAccountId(
          normalizeAgentProviderSession(entry.providerSession)?.transcriptPath,
          state.settings?.claudeManagedAccounts ?? []
        )
        yield { worktreeId, tab, leafId, ptyId, accountId }
      }
    }
  }
}

/** Queued Claude restarts in the switch's lane whose session already runs on `accountId`. */
export function findQueuedClaudeRestartsOnAccount(args: {
  owner: RuntimeClientTarget
  target: CodexAccountSelectionTarget
  accountId: string | null
}): string[] {
  const state = useAppStore.getState()
  const ptyIds: string[] = []
  for (const pane of localClaudePanesInLane(state, args.owner, args.target)) {
    if (
      state.pendingPaneAccountRestarts[pane.ptyId] === 'claude' &&
      pane.accountId === args.accountId
    ) {
      ptyIds.push(pane.ptyId)
    }
  }
  return ptyIds
}

/**
 * Local panes running a resumable Claude session in the switched lane. Why none for remote
 * owners: a relay or SSH machine keeps its own Claude login.
 */
export async function findMovableClaudeSessions(args: {
  owner: RuntimeClientTarget
  target: CodexAccountSelectionTarget
  /** Only sessions known to run on this account count; null is System default. */
  fromAccountId: string | null
  /** Sessions left out because their foreground could not be read. */
  onUnchecked?: (sessions: ClaudeSessionMoveCandidate[]) => void
}): Promise<ClaudeSessionMoveCandidate[]> {
  if (args.owner.kind !== 'local') {
    return []
  }
  const candidates: ClaudeSessionMoveCandidate[] = []
  for (const pane of localClaudePanesInLane(useAppStore.getState(), args.owner, args.target)) {
    if (pane.accountId !== args.fromAccountId) {
      continue
    }
    const resumeStartup = resolveAgentAccountRestartResumeStartup('claude', {
      tabId: pane.tab.id,
      leafId: pane.leafId,
      worktreeId: pane.worktreeId,
      shellOverride: pane.tab.shellOverride
    })
    if (resumeStartup) {
      candidates.push({
        ptyId: pane.ptyId,
        worktreeId: pane.worktreeId,
        tabId: pane.tab.id,
        leafId: pane.leafId
      })
    }
  }
  // Why: a Windows host cannot see processes inside WSL, so the guest's hooks and shell marks decide.
  if (normalizeCodexAccountSelectionTarget(args.target).runtime === 'wsl') {
    const state = useAppStore.getState()
    return candidates.filter(
      (candidate) =>
        resolvePaneAgentSessionId(state, makePaneKey(candidate.tabId, candidate.leafId)) !== null
    )
  }
  const inForeground = await Promise.all(
    candidates.map((candidate) =>
      inspectRuntimeTerminalProcess(candidate.ptyId).then(
        (inspection) => isClaudeInForeground(candidate.ptyId, inspection),
        () => false
      )
    )
  )
  const unchecked = candidates.filter((_, index) => inForeground[index] === 'unchecked')
  if (unchecked.length > 0) {
    args.onUnchecked?.(unchecked)
  }
  return candidates.filter((_, index) => inForeground[index] === true)
}
